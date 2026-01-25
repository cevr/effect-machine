import type { Effect } from "effect";

import type { MachineRef } from "../Machine.js";

/**
 * Extracts _tag from a tagged union member
 */
export type TagOf<T> = T extends { readonly _tag: infer Tag } ? Tag : never;

/**
 * Extracts args type from a Data.taggedEnum constructor
 */
export type ArgsOf<C> = C extends (args: infer A) => unknown ? A : never;

/**
 * Extracts return type from a Data.taggedEnum constructor
 */
export type InstanceOf<C> = C extends (...args: unknown[]) => infer R ? R : never;

/**
 * A tagged union constructor (from Data.taggedEnum)
 */
export type TaggedConstructor<T extends { readonly _tag: string }> = (args: Omit<T, "_tag">) => T;

/**
 * Transition handler result - either a new state or Effect producing one
 */
export type TransitionResult<State, R> = State | Effect.Effect<State, never, R>;

// ============================================================================
// Context Objects
// ============================================================================

/**
 * Context passed to transition handlers and guards
 */
export interface TransitionContext<State, Event> {
  readonly state: State;
  readonly event: Event;
}

/**
 * Context passed to state effect handlers (onEnter, onExit, invoke)
 */
export interface StateEffectContext<State, Event> {
  readonly state: State;
  readonly self: MachineRef<Event>;
}

// ============================================================================
// Handlers and Guards
// ============================================================================

/**
 * Transition handler function with context
 */
export type TransitionHandler<S, E, NewState, R> = (
  ctx: TransitionContext<S, E>,
) => TransitionResult<NewState, R>;

/**
 * Guard predicate with context
 */
export type GuardFn<S, E> = (ctx: TransitionContext<S, E>) => boolean;

/**
 * State effect handler with context
 */
export type StateEffectHandler<S, E, R> = (
  ctx: StateEffectContext<S, E>,
) => Effect.Effect<void, never, R>;

/**
 * Options for transition handlers
 */
export interface TransitionOptions<S, E, R> {
  readonly guard?: GuardFn<S, E>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
}

// ============================================================================
// Guard Module - Composable guards
// ============================================================================

/**
 * A composable guard that can be combined with other guards
 */
export interface Guard<S, E> {
  readonly _tag: "Guard";
  readonly predicate: GuardFn<S, E>;
}

/**
 * Guard module for creating and composing guards
 */
export const Guard = {
  /**
   * Create a guard from a predicate function
   */
  make: <S, E>(predicate: GuardFn<S, E>): Guard<S, E> => ({
    _tag: "Guard",
    predicate,
  }),

  /**
   * Combine guards with logical AND
   */
  and: <S, E>(...guards: Guard<S, E>[]): Guard<S, E> => ({
    _tag: "Guard",
    predicate: (ctx) => guards.every((g) => g.predicate(ctx)),
  }),

  /**
   * Combine guards with logical OR
   */
  or: <S, E>(...guards: Guard<S, E>[]): Guard<S, E> => ({
    _tag: "Guard",
    predicate: (ctx) => guards.some((g) => g.predicate(ctx)),
  }),

  /**
   * Negate a guard
   */
  not: <S, E>(guard: Guard<S, E>): Guard<S, E> => ({
    _tag: "Guard",
    predicate: (ctx) => !guard.predicate(ctx),
  }),

  /**
   * All guards must pass (alias for and)
   */
  all: <S, E>(...guards: Guard<S, E>[]): Guard<S, E> => Guard.and(...guards),

  /**
   * Any guard must pass (alias for or)
   */
  any: <S, E>(...guards: Guard<S, E>[]): Guard<S, E> => Guard.or(...guards),

  /**
   * Convert a Guard to a GuardFn (unwrap)
   */
  toFn: <S, E>(guard: Guard<S, E>): GuardFn<S, E> => guard.predicate,

  /**
   * Check if a value is a Guard object
   */
  isGuard: <S, E>(value: unknown): value is Guard<S, E> =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "Guard",
};

/**
 * Guard input - either a Guard object or a predicate function
 */
export type GuardInput<S, E> = Guard<S, E> | GuardFn<S, E>;

/**
 * Normalize guard input to a predicate function
 */
export const normalizeGuard = <S, E>(input: GuardInput<S, E>): GuardFn<S, E> =>
  Guard.isGuard<S, E>(input) ? (input as Guard<S, E>).predicate : (input as GuardFn<S, E>);
