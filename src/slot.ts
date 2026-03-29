/**
 * Slot module — unified, schema-based parameterized slots.
 *
 * Replaces the split Guards/Effects API with a single `Slot.define` + `Slot.fn`.
 * Each slot declares its parameter schema and (optional) return schema.
 * Handlers receive only params — machine context is accessed via `yield* machine.Context`.
 *
 * @example
 * ```ts
 * import { Slot } from "effect-machine"
 * import { Schema } from "effect"
 *
 * const MySlots = Slot.define({
 *   canRetry: Slot.fn({ max: Schema.Number }, Schema.Boolean),
 *   isValid: Slot.fn({}, Schema.Boolean),
 *   fetchData: Slot.fn({ url: Schema.String }),
 *   notify: Slot.fn({ message: Schema.String }),
 * })
 *
 * // Used in handlers:
 * .on(State.X, Event.Y, ({ slots }) =>
 *   Effect.gen(function* () {
 *     if (yield* slots.canRetry({ max: 3 })) {
 *       yield* slots.fetchData({ url: "/api" })
 *       return State.Next
 *     }
 *     return state
 *   })
 * )
 * ```
 *
 * @module
 */
import { ServiceMap } from "effect";
import type { Effect, Schema } from "effect";
import type { ActorSystem } from "./actor.js";

// ============================================================================
// Type-level utilities
// ============================================================================

/** Schema fields definition (like Schema.Struct.Fields) */
type Fields = Record<string, Schema.Top>;

/** Extract the type from schema fields (used for parameters) */
type FieldsToParams<F extends Fields> = keyof F extends never
  ? void
  : Schema.Schema.Type<Schema.Struct<F>>;

// ============================================================================
// SlotFnDef — individual slot definition
// ============================================================================

/**
 * Definition of a single slot function.
 * Created via `Slot.fn(params, returnSchema?)`.
 */
export interface SlotFnDef<F extends Fields = Fields, Return = void> {
  readonly _tag: "SlotFnDef";
  readonly fields: F;
  /** Return schema — Schema.Boolean for guards, undefined for void effects */
  readonly returnSchema: Schema.Schema<Return> | undefined;
}

/**
 * Define a single slot function with parameter schema and optional return schema.
 *
 * @example
 * ```ts
 * // Guard-like: returns boolean
 * Slot.fn({ max: Schema.Number }, Schema.Boolean)
 *
 * // Effect-like: returns void (default)
 * Slot.fn({ url: Schema.String })
 *
 * // No params, returns boolean
 * Slot.fn({}, Schema.Boolean)
 * ```
 */
export const fn: {
  <F extends Fields, Return>(fields: F, returnSchema: Schema.Schema<Return>): SlotFnDef<F, Return>;
  <F extends Fields>(fields: F): SlotFnDef<F, void>;
} = <F extends Fields, Return = void>(
  fields: F,
  returnSchema?: Schema.Schema<Return>,
): SlotFnDef<F, Return> => ({
  _tag: "SlotFnDef",
  fields,
  returnSchema: returnSchema as SlotFnDef<F, Return>["returnSchema"],
});

// ============================================================================
// SlotsDef — definition record
// ============================================================================

/**
 * Record of slot definitions. Keys are slot names, values are SlotFnDef.
 */
export type SlotsDef = Record<string, SlotFnDef<Fields, unknown>>;

// ============================================================================
// SlotsSchema — returned by Slot.define()
// ============================================================================

/**
 * Slots schema — returned by `Slot.define()`. Passed to `Machine.make({ slots })`.
 */
export interface SlotsSchema<D extends SlotsDef> {
  readonly _tag: "SlotsSchema";
  readonly definitions: D;
  /** Create callable slot proxies (used by Machine internally) */
  readonly _createSlots: (
    resolve: <N extends keyof D & string>(
      name: N,
      params: SlotParams<D[N]>,
    ) => Effect.Effect<SlotReturn<D[N]>>,
  ) => SlotCalls<D>;
}

// ============================================================================
// SlotCalls — callable slot proxies available in handler context
// ============================================================================

/** Extract params type from a SlotFnDef */
type SlotParams<D extends SlotFnDef<Fields, unknown>> =
  D extends SlotFnDef<infer F, unknown> ? FieldsToParams<F> : never;

/** Extract return type from a SlotFnDef */
type SlotReturn<D extends SlotFnDef<Fields, unknown>> =
  D extends SlotFnDef<Fields, infer R> ? R : never;

/**
 * A callable slot — function that takes params and returns Effect<Return>.
 */
export interface SlotCall<Name extends string, Params, Return> {
  readonly _tag: "Slot";
  readonly name: Name;
  (params: Params): Effect.Effect<Return>;
}

/**
 * Convert slot definitions to callable slot proxies.
 */
export type SlotCalls<D extends SlotsDef> = {
  readonly [K in keyof D & string]: SlotCall<K, SlotParams<D[K]>, SlotReturn<D[K]>>;
};

// ============================================================================
// SlotHandler / ProvideSlots — handler implementations at spawn time
// ============================================================================

/**
 * Slot handler implementation.
 * Receives only params — use `yield* machine.Context` for machine context.
 */
export type SlotHandler<Params, Return, R = never> = (
  params: Params,
) => Return | Effect.Effect<Return, never, R>;

/**
 * Handler implementations for all slots in a definition.
 */
export type ProvideSlots<D extends SlotsDef, R = never> = {
  readonly [K in keyof D & string]: SlotHandler<SlotParams<D[K]>, SlotReturn<D[K]>, R>;
};

/** Check if a SlotsDef has any actual keys */
export type HasSlotKeys<SD extends SlotsDef> = [keyof SD] extends [never]
  ? false
  : SD extends Record<string, never>
    ? false
    : true;

// ============================================================================
// Machine Context Tag
// ============================================================================

/**
 * Type for machine context — state, event, and self reference.
 * Shared across all machines via MachineContextTag.
 */
export interface MachineContext<State, Event, Self> {
  readonly actorId: string;
  readonly state: State;
  readonly event: Event;
  readonly self: Self;
  readonly system: ActorSystem;
}

/**
 * Shared Context tag for all machines.
 * Single module-level tag instead of per-machine allocation.
 * @internal
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- generic context tag */
export const MachineContextTag =
  ServiceMap.Service<MachineContext<any, any, any>>("@effect-machine/Context");
/* eslint-enable @typescript-eslint/no-explicit-any */

// ============================================================================
// Slot.define — factory
// ============================================================================

/**
 * Define a set of slots with parameter and return schemas.
 *
 * @example
 * ```ts
 * const MySlots = Slot.define({
 *   canRetry: Slot.fn({ max: Schema.Number }, Schema.Boolean),
 *   fetchData: Slot.fn({ url: Schema.String }),
 *   notify: Slot.fn({ message: Schema.String }),
 * })
 * ```
 */
export const define = <D extends SlotsDef>(definitions: D): SlotsSchema<D> => ({
  _tag: "SlotsSchema",
  definitions,
  _createSlots: (resolve) => {
    const slots: Record<string, unknown> = {};
    for (const name of Object.keys(definitions)) {
      const slot = (params: unknown) => resolve(name, params as SlotParams<D[typeof name]>);
      Object.defineProperty(slot, "_tag", { value: "Slot", enumerable: true });
      Object.defineProperty(slot, "name", { value: name, enumerable: true });
      slots[name] = slot;
    }
    return slots as SlotCalls<D>;
  },
});

// ============================================================================
// Backward-compat aliases (deprecated)
// ============================================================================

/**
 * @deprecated Use `SlotsDef` instead.
 */
export type GuardsDef = SlotsDef;

/**
 * @deprecated Use `SlotsDef` instead.
 */
export type EffectsDef = SlotsDef;

/**
 * @deprecated Use `SlotsSchema` instead.
 */
export type GuardsSchema<D extends SlotsDef> = SlotsSchema<D>;

/**
 * @deprecated Use `SlotsSchema` instead.
 */
export type EffectsSchema<D extends SlotsDef> = SlotsSchema<D>;

/**
 * @deprecated Use `SlotCalls` instead.
 */
export type GuardSlots<D extends SlotsDef> = SlotCalls<D>;

/**
 * @deprecated Use `SlotCalls` instead.
 */
export type EffectSlots<D extends SlotsDef> = SlotCalls<D>;

/**
 * @deprecated Use `SlotCall` instead.
 */
export type GuardSlot<Name extends string, Params> = SlotCall<Name, Params, boolean>;

/**
 * @deprecated Use `SlotCall` instead.
 */
export type EffectSlot<Name extends string, Params> = SlotCall<Name, Params, void>;

/**
 * @deprecated Use `SlotHandler` instead.
 */
export type GuardHandler<Params, _Ctx, R = never> = SlotHandler<Params, boolean, R>;

/**
 * @deprecated Use `SlotHandler` instead.
 */
export type EffectHandler<Params, _Ctx, R = never> = SlotHandler<Params, void, R>;

/**
 * @deprecated Use `ProvideSlots` instead.
 */
export type GuardHandlers<D extends SlotsDef, _MachineCtx, R = never> = ProvideSlots<D, R>;

/**
 * @deprecated Use `ProvideSlots` instead.
 */
export type EffectHandlers<D extends SlotsDef, _MachineCtx, R = never> = ProvideSlots<D, R>;

// ============================================================================
// Slot namespace export
// ============================================================================

export const Slot = {
  fn,
  define,
} as const;
