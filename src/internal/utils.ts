/**
 * Internal utilities for effect-machine.
 * @internal
 */
import { Effect, Stream } from "effect";
import type { ActorSystem } from "../actor.js";

// ============================================================================
// Type Helpers
// ============================================================================

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
 * @internal
 */
export type InstanceOf<C> = C extends (...args: unknown[]) => infer R ? R : never;

/**
 * A tagged union constructor (from Data.taggedEnum)
 */
export type TaggedConstructor<T extends { readonly _tag: string }> = (args: Omit<T, "_tag">) => T;

/**
 * Transition handler result - either a new state or Effect producing one
 */
/** Reply tuple returned from transition handlers for ask support */
export interface TransitionReply<State> {
  readonly state: State;
  readonly reply: unknown;
}

export type TransitionResult<State, R> =
  | State
  | TransitionReply<State>
  | Effect.Effect<State | TransitionReply<State>, never, R>;

// ============================================================================
// Constants
// ============================================================================

/**
 * Internal event tags used for lifecycle effect contexts.
 * Prefixed with $ to distinguish from user events.
 * @internal
 */
export const INTERNAL_INIT_EVENT = "$init" as const;
export const INTERNAL_ENTER_EVENT = "$enter" as const;

// ============================================================================
// Runtime Utilities
// ============================================================================

/**
 * Extract _tag from a tagged value or constructor.
 *
 * Supports:
 * - Plain values with `_tag` (MachineSchema empty structs)
 * - Constructors with static `_tag` (MachineSchema non-empty structs)
 * - Data.taggedEnum constructors (fallback via instantiation)
 */
export const getTag = (
  constructorOrValue: { _tag: string } | ((...args: never[]) => { _tag: string }),
): string => {
  // Direct _tag property (values or static on constructors)
  if ("_tag" in constructorOrValue && typeof constructorOrValue._tag === "string") {
    return constructorOrValue._tag;
  }
  // Fallback: instantiate (Data.taggedEnum compatibility)
  // Try zero-arg first, then empty object for record constructors
  try {
    return (constructorOrValue as () => { _tag: string })()._tag;
  } catch {
    return (constructorOrValue as (args: object) => { _tag: string })({})._tag;
  }
};

/** Check if a value is an Effect */
export const isEffect: (value: unknown) => value is Effect.Effect<unknown, unknown, unknown> =
  Effect.isEffect;

// ============================================================================
// Stub System
// ============================================================================

/**
 * Stub ActorSystem that dies on any method call.
 * Used in contexts where spawning/system access isn't supported
 * (testing simulation, persistent actor replay).
 * @internal
 */
export const stubSystem: ActorSystem = {
  spawn: () => Effect.die("spawn not supported in stub system"),
  restore: () => Effect.die("restore not supported in stub system"),
  get: () => Effect.die("get not supported in stub system"),
  stop: () => Effect.die("stop not supported in stub system"),
  events: Stream.empty,
  get actors() {
    return new Map();
  },
  subscribe: () => () => {},
  listPersisted: () => Effect.die("listPersisted not supported in stub system"),
  restoreMany: () => Effect.die("restoreMany not supported in stub system"),
  restoreAll: () => Effect.die("restoreAll not supported in stub system"),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural stub, overloaded spawn signature doesn't match
} as any;
