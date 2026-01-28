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
// Guard Module - Slots only (must be provided via Machine.provide)
// ============================================================================

/**
 * Guard predicate - sync boolean or Effect<boolean>
 */
export type GuardPredicate<S, E, R = never> = (
  ctx: TransitionContext<S, E>,
) => boolean | Effect.Effect<boolean, never, R>;

/**
 * A guard that must be provided via Machine.provide().
 *
 * Guards form a tree structure supporting hierarchical composition:
 * - Leaf: named slot resolved from guardHandlers
 * - And: all children must pass
 * - Or: any child must pass
 * - Not: negates single child
 *
 * @example
 * ```ts
 * // Simple guard slot
 * .on(State.Idle, Event.Start, handler, { guard: Guard.make("canStart") })
 *
 * // Hierarchical composition
 * .on(State.Idle, Event.Submit, handler, {
 *   guard: Guard.and(
 *     Guard.make("isValid"),
 *     Guard.or(Guard.make("isAdmin"), Guard.make("isOwner")),
 *     Guard.not(Guard.make("isLocked"))
 *   )
 * })
 *
 * // Provide implementations
 * machine.provide({
 *   canStart: ({ state }) => state.ready,
 *   isValid: ({ state }) => state.data !== null,
 *   isAdmin: ({ state }) => state.role === "admin",
 *   isOwner: ({ state }) => state.userId === state.ownerId,
 *   isLocked: ({ state }) => state.locked
 * })
 * ```
 */
export type Guard<_S, _E, _R = never> =
  | { readonly _tag: "GuardSlot"; readonly name: string }
  | { readonly _tag: "GuardAnd"; readonly guards: readonly Guard<_S, _E, _R>[] }
  | { readonly _tag: "GuardOr"; readonly guards: readonly Guard<_S, _E, _R>[] }
  | { readonly _tag: "GuardNot"; readonly guard: Guard<_S, _E, _R> };

/** Input for guard composition - either a Guard or a string name */
export type GuardOrName<S, E, R = never> = Guard<S, E, R> | string;

/** Normalize string to Guard */
const toGuard = <S, E, R = never>(input: GuardOrName<S, E, R>): Guard<S, E, R> =>
  typeof input === "string" ? { _tag: "GuardSlot", name: input } : input;

/**
 * Guard module for creating named guard slots and composing them
 */
export const Guard = {
  /**
   * Create a named guard slot.
   * The predicate must be provided via Machine.provide().
   */
  make: <S, E, R = never>(name: string): Guard<S, E, R> => ({
    _tag: "GuardSlot",
    name,
  }),

  /**
   * Combine guards with logical AND (all must pass).
   * Accepts Guard objects or string names.
   *
   * @example
   * ```ts
   * Guard.and("isReady", "hasPermission")
   * Guard.and("isReady", Guard.not("isLocked"))
   * ```
   */
  and: <S, E, R = never>(...guards: GuardOrName<S, E, R>[]): Guard<S, E, R> => ({
    _tag: "GuardAnd",
    guards: guards.map(toGuard),
  }),

  /**
   * Combine guards with logical OR (any must pass).
   * Accepts Guard objects or string names.
   *
   * @example
   * ```ts
   * Guard.or("isAdmin", "isOwner")
   * ```
   */
  or: <S, E, R = never>(...guards: GuardOrName<S, E, R>[]): Guard<S, E, R> => ({
    _tag: "GuardOr",
    guards: guards.map(toGuard),
  }),

  /**
   * Negate a guard.
   * Accepts Guard object or string name.
   *
   * @example
   * ```ts
   * Guard.not("isLocked")
   * Guard.not(Guard.and("a", "b"))
   * ```
   */
  not: <S, E, R = never>(guard: GuardOrName<S, E, R>): Guard<S, E, R> => ({
    _tag: "GuardNot",
    guard: toGuard(guard),
  }),

  /**
   * Check if a value is a Guard object
   */
  isGuard: <S, E, R = never>(value: unknown): value is Guard<S, E, R> =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as { _tag: unknown })._tag === "string" &&
    (value as { _tag: string })._tag.startsWith("Guard"),
};

/**
 * Collect all leaf slot names from a guard tree
 */
export const collectGuardSlotNames = (guard: Guard<unknown, unknown, unknown>): string[] => {
  switch (guard._tag) {
    case "GuardSlot":
      return [guard.name];
    case "GuardAnd":
    case "GuardOr":
      return guard.guards.flatMap(collectGuardSlotNames);
    case "GuardNot":
      return collectGuardSlotNames(guard.guard);
  }
};

/**
 * Get display name for a guard tree
 */
export const getGuardDisplayName = (guard: Guard<unknown, unknown, unknown>): string => {
  switch (guard._tag) {
    case "GuardSlot":
      return guard.name;
    case "GuardAnd":
      return `and(${guard.guards.map(getGuardDisplayName).join(", ")})`;
    case "GuardOr":
      return `or(${guard.guards.map(getGuardDisplayName).join(", ")})`;
    case "GuardNot":
      return `not(${getGuardDisplayName(guard.guard)})`;
  }
};

/**
 * Guard input - Guard object only (slots-only pattern)
 */
export type GuardInput<S, E, R = never> = Guard<S, E, R>;

/**
 * Normalized guard for storage on transitions
 */
export interface NormalizedGuard<S, E, R = never> {
  /** Display name */
  readonly name: string;
  /** All slot names that need provision */
  readonly slotNames: readonly string[];
  /** The guard tree for evaluation */
  readonly guard: Guard<S, E, R>;
}

/**
 * Normalize guard input to a structured form.
 */
export const normalizeGuard = <S, E, R = never>(
  input: GuardInput<S, E, R>,
): NormalizedGuard<S, E, R> => ({
  name: getGuardDisplayName(input),
  slotNames: collectGuardSlotNames(input),
  guard: input,
});
