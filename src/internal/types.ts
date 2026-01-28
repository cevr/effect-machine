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
