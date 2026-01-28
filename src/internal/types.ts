import type { Effect } from "effect";

import type { MachineRef } from "../machine.js";

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
 * Context passed to transition handlers (legacy - for backward compatibility)
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
// Handlers (legacy types for backward compatibility)
// ============================================================================

/**
 * Transition handler function with context (legacy)
 * @deprecated Use HandlerContext from machine.ts instead
 */
export type TransitionHandler<S, E, NewState, R> = (
  ctx: TransitionContext<S, E>,
) => TransitionResult<NewState, R>;

/**
 * Guard predicate with context (legacy)
 * @deprecated Guards are now schema-based slots
 */
export type GuardFn<S, E> = (ctx: TransitionContext<S, E>) => boolean;

/**
 * State effect handler with context (legacy)
 * @deprecated Use StateEffectHandler from machine.ts instead
 */
export type StateEffectHandler<S, E, R> = (
  ctx: StateEffectContext<S, E>,
) => Effect.Effect<void, never, R>;

/**
 * Options for transition handlers (legacy)
 * @deprecated No longer used - guard/effect logic goes in handler body
 */
export interface TransitionOptions<S, E, R> {
  readonly guard?: GuardFn<S, E>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
}
