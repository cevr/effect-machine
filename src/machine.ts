import type { Effect, Schema } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";

import type {
  GuardFn,
  GuardInput,
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
  readonly guard?: GuardFn<State, Event>;
  readonly guardName?: string;
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
 * Effect slot type - represents a named slot for an effect
 */
export type EffectSlot =
  | { readonly type: "invoke"; readonly stateTag: string; readonly name: string }
  | { readonly type: "onEnter"; readonly stateTag: string; readonly name: string }
  | { readonly type: "onExit"; readonly stateTag: string; readonly name: string };

/**
 * Machine definition
 *
 * The `Effects` type parameter tracks named effect slots that must be provided
 * before the machine can be spawned. Use `Machine.provide` to supply handlers.
 */
export interface Machine<
  State,
  Event,
  R = never,
  _Effects extends string = never,
> extends Pipeable {
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
  readonly effectSlots: ReadonlyMap<string, EffectSlot>;
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
interface MachineMutable<
  State,
  Event,
  R = never,
  _Effects extends string = never,
> extends Pipeable {
  initial: State;
  transitions: Array<Transition<State, Event, R>>;
  alwaysTransitions: Array<AlwaysTransition<State, R>>;
  onEnter: Array<StateEffect<State, Event, R>>;
  onExit: Array<StateEffect<State, Event, R>>;
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
  machine.finalStates = new Set();
  machine.effectSlots = new Map();
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
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    transition: Transition<S, E, R2>,
  ) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R | R2, Effects> => ({
    ...machine,
    transitions: [...machine.transitions, transition as Transition<S, E, R | R2>],
  });

/**
 * Add an always (eventless) transition
 */
export const addAlwaysTransition =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    transition: AlwaysTransition<S, R2>,
  ) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R | R2, Effects> => ({
    ...machine,
    alwaysTransitions: [...machine.alwaysTransitions, transition as AlwaysTransition<S, R | R2>],
  });

/**
 * Add an entry effect
 */
export const addOnEnter =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R | R2, Effects> => ({
    ...machine,
    onEnter: [...machine.onEnter, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Add an exit effect
 */
export const addOnExit =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R | R2, Effects> => ({
    ...machine,
    onExit: [...machine.onExit, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Mark a state as final
 */
export const addFinal =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string>(stateTag: string) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R, Effects> => ({
    ...machine,
    finalStates: new Set([...machine.finalStates, stateTag]),
  });

/**
 * Add an effect slot
 */
export const addEffectSlot =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, Name extends string>(
    slot: EffectSlot,
  ) =>
  (machine: Machine<S, E, R, Effects>): Machine<S, E, R, Effects | Name> => ({
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
 * Normalize OnOptions guard to GuardFn and extract guard name
 */
export const normalizeOnOptions = <S, E, R>(
  options?: OnOptions<S, E, R>,
):
  | {
      guard?: GuardFn<S, E>;
      guardName?: string;
      effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
      reenter?: boolean;
    }
  | undefined => {
  if (options === undefined) return undefined;

  // Extract guard name if it's a Guard object
  let guardName: string | undefined;
  if (options.guard !== undefined && typeof options.guard === "object" && "_tag" in options.guard) {
    guardName = (options.guard as { name?: string }).name;
  }

  return {
    ...options,
    guard: options.guard !== undefined ? normalizeGuard(options.guard) : undefined,
    guardName,
  };
};
