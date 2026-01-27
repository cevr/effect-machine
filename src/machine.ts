import type { Effect, Schema } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";

import type {
  GuardInput,
  GuardPredicate,
  StateEffectContext,
  TaggedConstructor,
  TransitionContext,
  TransitionResult,
} from "./internal/types.js";
import { normalizeGuard } from "./internal/types.js";
import type { StateBrand, EventBrand } from "./internal/brands.js";
import type { MachineStateSchema, MachineEventSchema } from "./machine-schema.js";

// Branded type constraints for compile-time safety
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Self reference for sending events back to the machine
 */
export interface MachineRef<Event> {
  readonly send: (event: Event) => Effect.Effect<void>;
}

/**
 * Transition definition with context-based handlers
 */
export interface Transition<State, Event, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: (ctx: TransitionContext<State, Event>) => TransitionResult<State, R>;
  /** Guard predicate - sync boolean or Effect<boolean> */
  readonly guard?: GuardPredicate<State, Event, R>;
  /** Guard name - for effect slot lookup when guard needs provision */
  readonly guardName?: string;
  /** Whether guard needs to be looked up from guardHandlers at runtime */
  readonly guardNeedsProvision?: boolean;
  readonly effect?: (ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R>;
  readonly reenter?: boolean;
}

/**
 * Always transition definition (eventless transitions)
 */
export interface AlwaysTransition<State, R> {
  readonly stateTag: string;
  readonly handler: (state: State) => TransitionResult<State, R>;
  readonly guard?: (state: State) => boolean;
}

/**
 * Entry/exit effect definition with context-based handlers
 */
export interface StateEffect<State, Event, R> {
  readonly stateTag: string;
  readonly handler: (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R>;
}

/**
 * Effect slot type - represents a named slot for an effect.
 * This is both a runtime type (stored in effectSlots map) and a phantom type parameter.
 */
export type EffectSlot =
  | { readonly type: "invoke"; readonly stateTag: string | null; readonly name: string }
  | { readonly type: "onEnter"; readonly stateTag: string; readonly name: string }
  | { readonly type: "onExit"; readonly stateTag: string; readonly name: string }
  | {
      readonly type: "guard";
      readonly stateTag: string;
      readonly eventTag: string;
      readonly name: string;
    };

/**
 * Type-level effect slot for phantom type tracking.
 * Mirrors EffectSlot but with literal types for compile-time inference.
 */
export type EffectSlotType<
  Type extends "invoke" | "onEnter" | "onExit" | "guard",
  Name extends string,
> = { readonly type: Type; readonly name: Name };

/** Any effect slot type (for constraints) */
export type AnySlot = EffectSlotType<"invoke" | "onEnter" | "onExit" | "guard", string>;

/**
 * Root invoke effect - runs for entire machine lifetime
 */
export interface RootInvoke<State, Event, R> {
  readonly name: string;
  readonly handler: (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R>;
}

/**
 * Guard handler function - receives context and returns Effect<boolean>
 */
export type GuardHandler<State, Event, R> = (
  ctx: TransitionContext<State, Event>,
) => Effect.Effect<boolean, never, R>;

/**
 * Machine definition
 *
 * The `Slots` type parameter tracks effect slots as a union of structs:
 * ```ts
 * | { type: "invoke"; name: "fetchData" }
 * | { type: "guard"; name: "canPrint" }
 * ```
 * Use `Machine.provide` to supply handlers - type enforces correct return type per slot.
 */
export interface Machine<State, Event, R = never, _Slots extends AnySlot = never> extends Pipeable {
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly rootInvokes: ReadonlyArray<RootInvoke<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
  readonly effectSlots: ReadonlyMap<string, EffectSlot>;
  /** Guard effect handlers (keyed by slot name) */
  readonly guardHandlers: ReadonlyMap<string, GuardHandler<State, Event, R>>;
  /** Schema for state (attached when using config-based make) */
  readonly stateSchema?: Schema.Schema<State, unknown, never>;
  /** Schema for events (attached when using config-based make) */
  readonly eventSchema?: Schema.Schema<Event, unknown, never>;
}

const PipeableProto: Pipeable = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

/** @internal Mutable version for construction */
interface MachineMutable<State, Event, R = never, _Slots extends AnySlot = never> extends Pipeable {
  initial: State;
  transitions: Array<Transition<State, Event, R>>;
  alwaysTransitions: Array<AlwaysTransition<State, R>>;
  onEnter: Array<StateEffect<State, Event, R>>;
  onExit: Array<StateEffect<State, Event, R>>;
  rootInvokes: Array<RootInvoke<State, Event, R>>;
  guardHandlers: Map<string, GuardHandler<State, Event, R>>;
  finalStates: Set<string>;
  effectSlots: Map<string, EffectSlot>;
  stateSchema?: Schema.Schema<State, unknown, never>;
  eventSchema?: Schema.Schema<Event, unknown, never>;
}

/**
 * Configuration for creating a machine with attached schemas
 */
export interface MakeConfig<
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
> {
  /** State schema - types will be inferred from this */
  readonly state: MachineStateSchema<SD> & { Type: S };
  /** Event schema - types will be inferred from this */
  readonly event: MachineEventSchema<ED> & { Type: E };
  /** Initial state value */
  readonly initial: S;
}

/**
 * Create a new machine with schemas and initial state.
 *
 * @example
 * ```ts
 * const OrderState = State({
 *   Pending: { orderId: Schema.String },
 *   Shipped: { trackingId: Schema.String },
 * });
 *
 * const OrderEvent = Event({
 *   Ship: { trackingId: Schema.String },
 * });
 *
 * const machine = Machine.make({
 *   state: OrderState,
 *   event: OrderEvent,
 *   initial: OrderState.Pending({ orderId: "" }),
 * });
 * // Types inferred from schemas - no manual type params needed!
 * ```
 */
export const make = <
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
>(
  config: MakeConfig<SD, ED, S, E>,
): Machine<S, E, never, never> => {
  const machine: MachineMutable<S, E, never, never> = Object.create(PipeableProto);
  machine.initial = config.initial;
  machine.transitions = [];
  machine.alwaysTransitions = [];
  machine.onEnter = [];
  machine.onExit = [];
  machine.rootInvokes = [];
  machine.finalStates = new Set();
  machine.effectSlots = new Map();
  machine.guardHandlers = new Map();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema types are compatible
  machine.stateSchema = config.state as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema types are compatible
  machine.eventSchema = config.event as any;
  return machine;
};

/**
 * Add a transition handler
 */
export const addTransition =
  <S extends BrandedState, E extends BrandedEvent, R, R2>(transition: Transition<S, E, R2>) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R | R2, Slots> => ({
    ...machine,
    transitions: [...machine.transitions, transition as Transition<S, E, R | R2>],
  });

/**
 * Add an always (eventless) transition
 */
export const addAlwaysTransition =
  <S extends BrandedState, E extends BrandedEvent, R, R2>(transition: AlwaysTransition<S, R2>) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R | R2, Slots> => ({
    ...machine,
    alwaysTransitions: [...machine.alwaysTransitions, transition as AlwaysTransition<S, R | R2>],
  });

/**
 * Add an entry effect
 */
export const addOnEnter =
  <S extends BrandedState, E extends BrandedEvent, R, R2>(effect: StateEffect<S, E, R2>) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R | R2, Slots> => ({
    ...machine,
    onEnter: [...machine.onEnter, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Add an exit effect
 */
export const addOnExit =
  <S extends BrandedState, E extends BrandedEvent, R, R2>(effect: StateEffect<S, E, R2>) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R | R2, Slots> => ({
    ...machine,
    onExit: [...machine.onExit, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Mark a state as final
 */
export const addFinal =
  <S extends BrandedState, E extends BrandedEvent, R>(stateTag: string) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R, Slots> => ({
    ...machine,
    finalStates: new Set([...machine.finalStates, stateTag]),
  });

/**
 * Add an effect slot
 */
export const addEffectSlot =
  <S extends BrandedState, E extends BrandedEvent, R, NewSlot extends AnySlot>(slot: EffectSlot) =>
  <Slots extends AnySlot>(machine: Machine<S, E, R, Slots>): Machine<S, E, R, Slots | NewSlot> => ({
    ...machine,
    effectSlots: new Map([...machine.effectSlots, [slot.name, slot]]),
  });

/**
 * Type helper to extract state type from constructor
 */
export type StateFromConstructor<C> = C extends TaggedConstructor<infer S> ? S : never;

/**
 * Type helper to extract event type from constructor
 */
export type EventFromConstructor<C> = C extends TaggedConstructor<infer E> ? E : never;

// ============================================================================
// Options types for combinators
// ============================================================================

/**
 * Options for the `on` combinator.
 * Use `on.force()` instead of reenter option for forced transitions.
 */
export interface OnOptions<S, E, R> {
  readonly guard?: GuardInput<S, E>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  /** @internal Use on.force() instead */
  readonly reenter?: boolean;
}

/**
 * Normalized guard options
 */
export interface NormalizedGuardOptions<S, E, R> {
  guard?: GuardPredicate<S, E, R>;
  guardName?: string;
  guardNeedsProvision?: boolean;
  effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  reenter?: boolean;
}

/**
 * Normalize OnOptions guard to structured form
 */
export const normalizeOnOptions = <S, E, R>(
  options?: OnOptions<S, E, R>,
): NormalizedGuardOptions<S, E, R> | undefined => {
  if (options === undefined) return undefined;

  if (options.guard === undefined) {
    return {
      effect: options.effect,
      reenter: options.reenter,
    };
  }

  const normalized = normalizeGuard(options.guard);

  return {
    guard: normalized.predicate,
    guardName: normalized.name,
    guardNeedsProvision: normalized.needsProvision,
    effect: options.effect,
    reenter: options.reenter,
  };
};
