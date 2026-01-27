import type { Effect } from "effect";
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
}

/**
 * Machine builder for fluent API
 *
 * The `Effects` type parameter tracks named effect slots that must be provided
 * before the machine can be spawned. Use `Machine.provide` to supply handlers.
 */
export interface MachineBuilder<
  State,
  Event,
  R = never,
  _Effects extends string = never,
> extends Pipeable {
  readonly _tag: "MachineBuilder";
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
  readonly effectSlots: ReadonlyMap<string, EffectSlot>;
}

const PipeableProto: Pipeable = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

/** @internal Mutable version for construction */
interface MachineBuilderMutable<
  State,
  Event,
  R = never,
  _Effects extends string = never,
> extends Pipeable {
  _tag: "MachineBuilder";
  initial: State;
  transitions: Array<Transition<State, Event, R>>;
  alwaysTransitions: Array<AlwaysTransition<State, R>>;
  onEnter: Array<StateEffect<State, Event, R>>;
  onExit: Array<StateEffect<State, Event, R>>;
  finalStates: Set<string>;
  effectSlots: Map<string, EffectSlot>;
}

/**
 * Create a new machine with initial state
 */
export const make = <State extends BrandedState, Event extends BrandedEvent>(
  initial: State,
): MachineBuilder<State, Event, never, never> => {
  const builder: MachineBuilderMutable<State, Event, never, never> = Object.create(PipeableProto);
  builder._tag = "MachineBuilder";
  builder.initial = initial;
  builder.transitions = [];
  builder.alwaysTransitions = [];
  builder.onEnter = [];
  builder.onExit = [];
  builder.finalStates = new Set();
  builder.effectSlots = new Map();
  return builder;
};

/**
 * Add a transition handler
 */
export const addTransition =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    transition: Transition<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R | R2, Effects> => ({
    ...builder,
    transitions: [...builder.transitions, transition as Transition<S, E, R | R2>],
  });

/**
 * Add an always (eventless) transition
 */
export const addAlwaysTransition =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    transition: AlwaysTransition<S, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R | R2, Effects> => ({
    ...builder,
    alwaysTransitions: [...builder.alwaysTransitions, transition as AlwaysTransition<S, R | R2>],
  });

/**
 * Add an entry effect
 */
export const addOnEnter =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R | R2, Effects> => ({
    ...builder,
    onEnter: [...builder.onEnter, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Add an exit effect
 */
export const addOnExit =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R | R2, Effects> => ({
    ...builder,
    onExit: [...builder.onExit, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Mark a state as final
 */
export const addFinal =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string>(stateTag: string) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R, Effects> => ({
    ...builder,
    finalStates: new Set([...builder.finalStates, stateTag]),
  });

/**
 * Add an effect slot
 */
export const addEffectSlot =
  <S extends BrandedState, E extends BrandedEvent, R, Effects extends string, Name extends string>(
    slot: EffectSlot,
  ) =>
  (builder: MachineBuilder<S, E, R, Effects>): MachineBuilder<S, E, R, Effects | Name> => ({
    ...builder,
    effectSlots: new Map([...builder.effectSlots, [slot.name, slot]]),
  });

/**
 * Build the machine from builder
 */
export const build = <S extends BrandedState, E extends BrandedEvent, R, Effects extends string>(
  builder: MachineBuilder<S, E, R, Effects>,
): Machine<S, E, R, Effects> => {
  const machine: Machine<S, E, R, Effects> = Object.create(PipeableProto);
  return Object.assign(machine, {
    initial: builder.initial,
    transitions: builder.transitions,
    alwaysTransitions: builder.alwaysTransitions,
    onEnter: builder.onEnter,
    onExit: builder.onExit,
    finalStates: builder.finalStates,
    effectSlots: builder.effectSlots,
  });
};

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
