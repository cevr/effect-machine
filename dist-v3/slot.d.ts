import { ActorSystem } from "./actor.js";
import { Effect, Schema } from "effect";

//#region src-v3/slot.d.ts
/** Schema fields definition (like Schema.Struct.Fields) */
type Fields = Record<string, Schema.Schema.All>;
/** Extract the encoded type from schema fields (used for parameters) */
type FieldsToParams<F extends Fields> = keyof F extends never
  ? void
  : Schema.Schema.Type<Schema.Struct<F>>;
/**
 * A guard slot - callable function that returns Effect<boolean>.
 */
interface GuardSlot<Name extends string, Params> {
  readonly _tag: "GuardSlot";
  readonly name: Name;
  (params: Params): Effect.Effect<boolean>;
}
/**
 * An effect slot - callable function that returns Effect<void>.
 */
interface EffectSlot<Name extends string, Params> {
  readonly _tag: "EffectSlot";
  readonly name: Name;
  (params: Params): Effect.Effect<void>;
}
/**
 * Guard definition - name to schema fields mapping
 */
type GuardsDef = Record<string, Fields>;
/**
 * Effect definition - name to schema fields mapping
 */
type EffectsDef = Record<string, Fields>;
/**
 * Convert guard definitions to callable guard slots
 */
type GuardSlots<D extends GuardsDef> = {
  readonly [K in keyof D & string]: GuardSlot<K, FieldsToParams<D[K]>>;
};
/**
 * Convert effect definitions to callable effect slots
 */
type EffectSlots<D extends EffectsDef> = {
  readonly [K in keyof D & string]: EffectSlot<K, FieldsToParams<D[K]>>;
};
/**
 * Type for machine context - state, event, and self reference.
 * Shared across all machines via MachineContextTag.
 */
interface MachineContext<State, Event, Self> {
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
declare const MachineContextTag: any;
/**
 * Guard handler implementation.
 * Receives params and context, returns Effect<boolean>.
 */
type GuardHandler<Params, Ctx, R = never> = (
  params: Params,
  ctx: Ctx,
) => boolean | Effect.Effect<boolean, never, R>;
/**
 * Effect handler implementation.
 * Receives params and context, returns Effect<void>.
 */
type EffectHandler<Params, Ctx, R = never> = (
  params: Params,
  ctx: Ctx,
) => Effect.Effect<void, never, R>;
/**
 * Handler types for all guards in a definition
 */
type GuardHandlers<D extends GuardsDef, MachineCtx, R = never> = {
  readonly [K in keyof D & string]: GuardHandler<FieldsToParams<D[K]>, MachineCtx, R>;
};
/**
 * Handler types for all effects in a definition
 */
type EffectHandlers<D extends EffectsDef, MachineCtx, R = never> = {
  readonly [K in keyof D & string]: EffectHandler<FieldsToParams<D[K]>, MachineCtx, R>;
};
/**
 * Guards schema - returned by Slot.Guards()
 */
interface GuardsSchema<D extends GuardsDef> {
  readonly _tag: "GuardsSchema";
  readonly definitions: D;
  /** Create callable guard slots (used by Machine internally) */
  readonly _createSlots: (
    resolve: <N extends keyof D & string>(
      name: N,
      params: FieldsToParams<D[N]>,
    ) => Effect.Effect<boolean>,
  ) => GuardSlots<D>;
}
/**
 * Effects schema - returned by Slot.Effects()
 */
interface EffectsSchema<D extends EffectsDef> {
  readonly _tag: "EffectsSchema";
  readonly definitions: D;
  /** Create callable effect slots (used by Machine internally) */
  readonly _createSlots: (
    resolve: <N extends keyof D & string>(
      name: N,
      params: FieldsToParams<D[N]>,
    ) => Effect.Effect<void>,
  ) => EffectSlots<D>;
}
/**
 * Create a guards schema with parameterized guard definitions.
 *
 * @example
 * ```ts
 * const MyGuards = Slot.Guards({
 *   canRetry: { max: Schema.Number },
 *   isValid: {},
 * })
 * ```
 */
declare const Guards: <D extends GuardsDef>(definitions: D) => GuardsSchema<D>;
/**
 * Create an effects schema with parameterized effect definitions.
 *
 * @example
 * ```ts
 * const MyEffects = Slot.Effects({
 *   fetchData: { url: Schema.String },
 *   notify: { message: Schema.String },
 * })
 * ```
 */
declare const Effects: <D extends EffectsDef>(definitions: D) => EffectsSchema<D>;
/** Extract guard definition type from GuardsSchema */
type GuardsDefOf<G> = G extends GuardsSchema<infer D> ? D : never;
/** Extract effect definition type from EffectsSchema */
type EffectsDefOf<E> = E extends EffectsSchema<infer D> ? D : never;
/** Extract guard slots type from GuardsSchema */
type GuardSlotsOf<G> = G extends GuardsSchema<infer D> ? GuardSlots<D> : never;
/** Extract effect slots type from EffectsSchema */
type EffectSlotsOf<E> = E extends EffectsSchema<infer D> ? EffectSlots<D> : never;
declare const Slot: {
  readonly Guards: <D extends GuardsDef>(definitions: D) => GuardsSchema<D>;
  readonly Effects: <D extends EffectsDef>(definitions: D) => EffectsSchema<D>;
};
//#endregion
export {
  EffectHandler,
  EffectHandlers,
  EffectSlot,
  EffectSlots,
  EffectSlotsOf,
  Effects,
  EffectsDef,
  EffectsDefOf,
  EffectsSchema,
  GuardHandler,
  GuardHandlers,
  GuardSlot,
  GuardSlots,
  GuardSlotsOf,
  Guards,
  GuardsDef,
  GuardsDefOf,
  GuardsSchema,
  MachineContext,
  MachineContextTag,
  Slot,
};
