import type { Effect } from "effect";

import type {
  GuardFn,
  GuardInput,
  StateEffectContext,
  TaggedConstructor,
  TransitionContext,
  TransitionResult,
} from "./internal/types.js";
import { normalizeGuard } from "./internal/types.js";

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
 * Machine definition
 */
export interface Machine<State, Event, R = never> {
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
}

/**
 * Machine builder for fluent API
 */
export interface MachineBuilder<State, Event, R = never> {
  readonly _tag: "MachineBuilder";
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
}

/**
 * Create a new machine with initial state
 */
export const make = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
>(
  initial: State,
): MachineBuilder<State, Event> => ({
  _tag: "MachineBuilder",
  initial,
  transitions: [],
  alwaysTransitions: [],
  onEnter: [],
  onExit: [],
  finalStates: new Set(),
});

/**
 * Add a transition handler
 */
export const addTransition =
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, R2>(
    transition: Transition<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R>): MachineBuilder<S, E, R | R2> => ({
    ...builder,
    transitions: [...builder.transitions, transition as Transition<S, E, R | R2>],
  });

/**
 * Add an always (eventless) transition
 */
export const addAlwaysTransition =
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, R2>(
    transition: AlwaysTransition<S, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R>): MachineBuilder<S, E, R | R2> => ({
    ...builder,
    alwaysTransitions: [...builder.alwaysTransitions, transition as AlwaysTransition<S, R | R2>],
  });

/**
 * Add an entry effect
 */
export const addOnEnter =
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R>): MachineBuilder<S, E, R | R2> => ({
    ...builder,
    onEnter: [...builder.onEnter, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Add an exit effect
 */
export const addOnExit =
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, R2>(
    effect: StateEffect<S, E, R2>,
  ) =>
  (builder: MachineBuilder<S, E, R>): MachineBuilder<S, E, R | R2> => ({
    ...builder,
    onExit: [...builder.onExit, effect as StateEffect<S, E, R | R2>],
  });

/**
 * Mark a state as final
 */
export const addFinal =
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(stateTag: string) =>
  (builder: MachineBuilder<S, E, R>): MachineBuilder<S, E, R> => ({
    ...builder,
    finalStates: new Set([...builder.finalStates, stateTag]),
  });

/**
 * Build the machine from builder
 */
export const build = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  builder: MachineBuilder<S, E, R>,
): Machine<S, E, R> => ({
  initial: builder.initial,
  transitions: builder.transitions,
  alwaysTransitions: builder.alwaysTransitions,
  onEnter: builder.onEnter,
  onExit: builder.onExit,
  finalStates: builder.finalStates,
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
 * Normalize OnOptions guard to GuardFn
 */
export const normalizeOnOptions = <S, E, R>(
  options?: OnOptions<S, E, R>,
):
  | {
      guard?: GuardFn<S, E>;
      effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
      reenter?: boolean;
    }
  | undefined => {
  if (options === undefined) return undefined;
  return {
    ...options,
    guard: options.guard !== undefined ? normalizeGuard(options.guard) : undefined,
  };
};
