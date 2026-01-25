import { Effect, SubscriptionRef } from "effect";

import type { Machine } from "./machine.js";
import { applyAlways, resolveTransition } from "./internal/loop.js";

/**
 * Yield to other fibers. Useful in tests to allow forked effects to run.
 */
export const yieldFibers = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) {
    yield* Effect.yieldNow();
  }
});

/**
 * Result of simulating events through a machine
 */
export interface SimulationResult<S> {
  readonly states: ReadonlyArray<S>;
  readonly finalState: S;
}

/**
 * Simulate a sequence of events through a machine without running an actor.
 * Useful for testing state transitions in isolation.
 * Does not run onEnter/onExit effects, but does apply always transitions.
 *
 * @example
 * ```ts
 * const result = yield* simulate(
 *   fetcherMachine,
 *   [
 *     Event.Fetch({ url: "https://example.com" }),
 *     Event._Done({ data: { foo: "bar" } })
 *   ]
 * )
 *
 * expect(result.finalState._tag).toBe("Success")
 * expect(result.states).toHaveLength(3) // Idle -> Loading -> Success
 * ```
 */
export const simulate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  events: ReadonlyArray<E>,
): Effect.Effect<SimulationResult<S>, never, R> =>
  Effect.gen(function* () {
    // Apply always transitions to initial state
    let currentState = yield* applyAlways(machine, machine.initial);
    const states: S[] = [currentState];

    for (const event of events) {
      // Use shared resolver for guard cascade support
      const transition = resolveTransition(machine, currentState, event);

      if (transition === undefined) {
        continue;
      }

      // Compute new state
      const newStateResult = transition.handler({ state: currentState, event });
      let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

      // Run transition effect if any (for side effects during test)
      if (transition.effect !== undefined) {
        yield* transition.effect({ state: currentState, event });
      }

      // Apply always transitions if state tag changed
      if (newState._tag !== currentState._tag) {
        newState = yield* applyAlways(machine, newState);
      }

      currentState = newState;
      states.push(currentState);

      // Stop if final state
      if (machine.finalStates.has(currentState._tag)) {
        break;
      }
    }

    return { states, finalState: currentState };
  });

/**
 * Error thrown when assertReaches fails
 */
export class AssertionError extends Error {
  readonly _tag = "AssertionError";
}

/**
 * Assert that a machine can reach a specific state given a sequence of events
 */
export const assertReaches = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  events: ReadonlyArray<E>,
  expectedTag: string,
): Effect.Effect<S, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);
    if (result.finalState._tag !== expectedTag) {
      return yield* Effect.fail(
        new AssertionError(
          `Expected final state "${expectedTag}" but got "${result.finalState._tag}". ` +
            `States visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
        ),
      );
    }
    return result.finalState;
  });

/**
 * Assert that a machine follows a specific path of state tags
 *
 * @example
 * ```ts
 * yield* assertPath(
 *   machine,
 *   [Event.Start(), Event.Increment(), Event.Stop()],
 *   ["Idle", "Counting", "Counting", "Done"]
 * )
 * ```
 */
export const assertPath = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  events: ReadonlyArray<E>,
  expectedPath: ReadonlyArray<string>,
): Effect.Effect<SimulationResult<S>, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);
    const actualPath = result.states.map((s) => s._tag);

    if (actualPath.length !== expectedPath.length) {
      return yield* Effect.fail(
        new AssertionError(
          `Path length mismatch. Expected ${expectedPath.length} states but got ${actualPath.length}.\n` +
            `Expected: ${expectedPath.join(" -> ")}\n` +
            `Actual:   ${actualPath.join(" -> ")}`,
        ),
      );
    }

    for (let i = 0; i < expectedPath.length; i++) {
      if (actualPath[i] !== expectedPath[i]) {
        return yield* Effect.fail(
          new AssertionError(
            `Path mismatch at position ${i}. Expected "${expectedPath[i]}" but got "${actualPath[i]}".\n` +
              `Expected: ${expectedPath.join(" -> ")}\n` +
              `Actual:   ${actualPath.join(" -> ")}`,
          ),
        );
      }
    }

    return result;
  });

/**
 * Assert that a machine never reaches a specific state given a sequence of events
 *
 * @example
 * ```ts
 * // Verify error handling doesn't reach crash state
 * yield* assertNeverReaches(
 *   machine,
 *   [Event.Error(), Event.Retry(), Event.Success()],
 *   "Crashed"
 * )
 * ```
 */
export const assertNeverReaches = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  events: ReadonlyArray<E>,
  forbiddenTag: string,
): Effect.Effect<SimulationResult<S>, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);

    const visitedIndex = result.states.findIndex((s) => s._tag === forbiddenTag);
    if (visitedIndex !== -1) {
      return yield* Effect.fail(
        new AssertionError(
          `Machine reached forbidden state "${forbiddenTag}" at position ${visitedIndex}.\n` +
            `States visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
        ),
      );
    }

    return result;
  });

/**
 * Create a controllable test harness for a machine
 */
export interface TestHarness<S, E, R> {
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  readonly send: (event: E) => Effect.Effect<S, never, R>;
  readonly getState: Effect.Effect<S>;
}

/**
 * Options for creating a test harness
 */
export interface TestHarnessOptions<S, E> {
  /**
   * Called after each transition with the previous state, event, and new state.
   * Useful for logging or spying on transitions.
   */
  readonly onTransition?: (from: S, event: E, to: S) => void;
}

/**
 * Create a test harness for step-by-step testing.
 * Does not run onEnter/onExit effects, but does apply always transitions.
 *
 * @example Basic usage
 * ```ts
 * const harness = yield* createTestHarness(machine)
 * yield* harness.send(Event.Start())
 * const state = yield* harness.getState
 * ```
 *
 * @example With transition observer
 * ```ts
 * const transitions: Array<{ from: string; event: string; to: string }> = []
 * const harness = yield* createTestHarness(machine, {
 *   onTransition: (from, event, to) =>
 *     transitions.push({ from: from._tag, event: event._tag, to: to._tag })
 * })
 * ```
 */
export const createTestHarness = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  options?: TestHarnessOptions<S, E>,
): Effect.Effect<TestHarness<S, E, R>, never, R> =>
  Effect.gen(function* () {
    // Apply always transitions to initial state
    const resolvedInitial = yield* applyAlways(machine, machine.initial);
    const stateRef = yield* SubscriptionRef.make(resolvedInitial);

    const send = (event: E): Effect.Effect<S, never, R> =>
      Effect.gen(function* () {
        const currentState = yield* SubscriptionRef.get(stateRef);

        // Use shared resolver for guard cascade support
        const transition = resolveTransition(machine, currentState, event);

        if (transition === undefined) {
          return currentState;
        }

        const newStateResult = transition.handler({ state: currentState, event });
        let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

        if (transition.effect !== undefined) {
          yield* transition.effect({ state: currentState, event });
        }

        // Apply always transitions if state tag changed
        if (newState._tag !== currentState._tag) {
          newState = yield* applyAlways(machine, newState);
        }

        yield* SubscriptionRef.set(stateRef, newState);

        // Call transition observer
        if (options?.onTransition !== undefined) {
          options.onTransition(currentState, event, newState);
        }

        return newState;
      });

    return {
      state: stateRef,
      send,
      getState: SubscriptionRef.get(stateRef),
    };
  });
