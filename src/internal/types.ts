import { Effect } from "effect";

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
// Guard Module - Composable guards
// ============================================================================

/**
 * Guard predicate - sync boolean or Effect<boolean>
 */
export type GuardPredicate<S, E, R = never> = (
  ctx: TransitionContext<S, E>,
) => boolean | Effect.Effect<boolean, never, R>;

/**
 * A composable guard that can be combined with other guards.
 *
 * Guards can be:
 * - Inline with predicate: `Guard.make("name", predicate)` - default provided, no slot needed
 * - Named slot only: `Guard.make("name")` - must be provided via Machine.provide()
 */
export interface Guard<S, E, R = never> {
  readonly _tag: "Guard";
  /** Guard name - used for effect slot registration when predicate is undefined */
  readonly name: string;
  /** Default predicate - if undefined, must be provided via Machine.provide() */
  readonly predicate?: GuardPredicate<S, E, R>;
}

// Counter for anonymous guards
let anonymousGuardCounter = 0;

/** @internal Check if a value is an Effect */
const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Effect.EffectTypeId in value;

/**
 * Guard module for creating and composing guards
 */
export const Guard = {
  /**
   * Create a guard.
   *
   * @example Anonymous guard (inline predicate only)
   * ```ts
   * Guard.make(({ state }) => state.canPrint)
   * ```
   *
   * @example Named guard with inline predicate (default provided)
   * ```ts
   * Guard.make("canPrint", ({ state }) => state.canPrint)
   * ```
   *
   * @example Named guard with Effect predicate
   * ```ts
   * Guard.make("hasPermission", ({ state }) =>
   *   Effect.gen(function* () {
   *     const auth = yield* AuthService
   *     return yield* auth.check(state.userId)
   *   })
   * )
   * ```
   *
   * @example Named slot only (must provide via Machine.provide)
   * ```ts
   * Guard.make("canPrint")
   *
   * // Later:
   * Machine.provide(machine, {
   *   canPrint: ({ state }) => state.canPrint
   * })
   * ```
   */
  make: <S, E, R = never>(
    nameOrPredicate: string | GuardPredicate<S, E, R>,
    predicate?: GuardPredicate<S, E, R>,
  ): Guard<S, E, R> => {
    if (typeof nameOrPredicate === "function") {
      // Anonymous guard: Guard.make(predicate)
      return {
        _tag: "Guard",
        name: `anonymous_${++anonymousGuardCounter}`,
        predicate: nameOrPredicate,
      };
    }
    // Named guard: Guard.make(name) or Guard.make(name, predicate)
    return {
      _tag: "Guard",
      name: nameOrPredicate,
      predicate,
    };
  },

  /**
   * Create a guard with auto-narrowed types from state/event constructors.
   *
   * @example Named guard
   * ```ts
   * const canRetry = Guard.for(State.Error, Event.Retry)(
   *   "canRetry",
   *   ({ state }) => state.attempts < 3
   * );
   * ```
   *
   * @example Anonymous guard
   * ```ts
   * const canRetry = Guard.for(State.Error, Event.Retry)(
   *   ({ state }) => state.attempts < 3
   * );
   * ```
   */
  for: <
    NarrowedState extends { readonly _tag: string },
    NarrowedEvent extends { readonly _tag: string },
  >(
    _stateConstructor: { (...args: never[]): NarrowedState },
    _eventConstructor: { (...args: never[]): NarrowedEvent },
  ) => {
    return <R = never>(
      nameOrPredicate: string | GuardPredicate<NarrowedState, NarrowedEvent, R>,
      predicate?: GuardPredicate<NarrowedState, NarrowedEvent, R>,
    ): Guard<NarrowedState, NarrowedEvent, R> =>
      Guard.make(
        nameOrPredicate as string | GuardPredicate<NarrowedState, NarrowedEvent, R>,
        predicate,
      );
  },

  /**
   * Combine guards with logical AND.
   * All guards must have predicates (not slots).
   */
  and: <S, E, R>(...guards: Guard<S, E, R>[]): Guard<S, E, R> => {
    const names = guards.map((g) => g.name);
    // All guards must have predicates for composition
    const predicates = guards.map((g) => {
      if (g.predicate === undefined) {
        throw new Error(
          `Cannot compose guard "${g.name}" - it has no predicate. Provide it first.`,
        );
      }
      return g.predicate;
    });
    return {
      _tag: "Guard",
      name: `and(${names.join(", ")})`,
      predicate: (ctx) => {
        for (let i = 0; i < predicates.length; i++) {
          const predicate = predicates[i];
          if (predicate === undefined) {
            continue;
          }
          const result = predicate(ctx);
          if (isEffect(result)) {
            return Effect.gen(function* () {
              if ((yield* result) === false) {
                return false;
              }
              for (let j = i + 1; j < predicates.length; j++) {
                const predicate = predicates[j];
                if (predicate === undefined) {
                  continue;
                }
                const next = predicate(ctx);
                if (isEffect(next)) {
                  if ((yield* next) === false) return false;
                } else if (next === false) {
                  return false;
                }
              }
              return true;
            });
          }
          if (result === false) {
            return false;
          }
        }
        return true;
      },
    };
  },

  /**
   * Combine guards with logical OR.
   * All guards must have predicates (not slots).
   */
  or: <S, E, R>(...guards: Guard<S, E, R>[]): Guard<S, E, R> => {
    const names = guards.map((g) => g.name);
    const predicates = guards.map((g) => {
      if (g.predicate === undefined) {
        throw new Error(
          `Cannot compose guard "${g.name}" - it has no predicate. Provide it first.`,
        );
      }
      return g.predicate;
    });
    return {
      _tag: "Guard",
      name: `or(${names.join(", ")})`,
      predicate: (ctx) => {
        for (let i = 0; i < predicates.length; i++) {
          const predicate = predicates[i];
          if (predicate === undefined) {
            continue;
          }
          const result = predicate(ctx);
          if (isEffect(result)) {
            return Effect.gen(function* () {
              if ((yield* result) === true) {
                return true;
              }
              for (let j = i + 1; j < predicates.length; j++) {
                const predicate = predicates[j];
                if (predicate === undefined) {
                  continue;
                }
                const next = predicate(ctx);
                if (isEffect(next)) {
                  if ((yield* next) === true) return true;
                } else if (next === true) {
                  return true;
                }
              }
              return false;
            });
          }
          if (result === true) {
            return true;
          }
        }
        return false;
      },
    };
  },

  /**
   * Negate a guard.
   * Guard must have a predicate (not a slot).
   */
  not: <S, E, R>(guard: Guard<S, E, R>): Guard<S, E, R> => {
    if (guard.predicate === undefined) {
      throw new Error(
        `Cannot negate guard "${guard.name}" - it has no predicate. Provide it first.`,
      );
    }
    const pred = guard.predicate;
    return {
      _tag: "Guard",
      name: `not(${guard.name})`,
      predicate: (ctx) => {
        const result = pred(ctx);
        return isEffect(result) ? Effect.map(result, (value) => value === false) : result === false;
      },
    };
  },

  /**
   * All guards must pass (alias for and)
   */
  all: <S, E, R>(...guards: Guard<S, E, R>[]): Guard<S, E, R> => Guard.and(...guards),

  /**
   * Any guard must pass (alias for or)
   */
  any: <S, E, R>(...guards: Guard<S, E, R>[]): Guard<S, E, R> => Guard.or(...guards),

  /**
   * Create a copy of a guard with a new name.
   * Useful for giving anonymous guards a name for debugging/inspection.
   */
  named: <S, E, R>(name: string, guard: Guard<S, E, R>): Guard<S, E, R> => ({
    _tag: "Guard",
    name,
    predicate: guard.predicate,
  }),

  /**
   * Check if a guard needs to be provided (has no predicate)
   */
  needsProvision: <S, E, R>(guard: Guard<S, E, R>): boolean => guard.predicate === undefined,

  /**
   * Check if a value is a Guard object
   */
  isGuard: <S, E, R = never>(value: unknown): value is Guard<S, E, R> =>
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as { _tag: unknown })._tag === "Guard",
};

/**
 * Guard input - Guard object, predicate function, or sync function
 */
export type GuardInput<S, E, R = never> = Guard<S, E, R> | GuardPredicate<S, E, R>;

/**
 * Normalized guard result - includes name if it's a slot that needs provision
 */
export interface NormalizedGuard<S, E, R = never> {
  readonly name?: string;
  readonly predicate?: GuardPredicate<S, E, R>;
  readonly needsProvision: boolean;
}

/**
 * Normalize guard input to a structured form
 */
export const normalizeGuard = <S, E, R = never>(
  input: GuardInput<S, E, R>,
): NormalizedGuard<S, E, R> => {
  if (Guard.isGuard<S, E, R>(input)) {
    const guard = input as Guard<S, E, R>;
    return {
      name: guard.name,
      predicate: guard.predicate,
      needsProvision: guard.predicate === undefined,
    };
  }
  // Raw predicate function - no slot needed
  return {
    predicate: input as GuardPredicate<S, E, R>,
    needsProvision: false,
  };
};
