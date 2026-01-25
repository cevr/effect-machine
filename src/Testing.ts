import { Effect, SubscriptionRef } from "effect";

import type { Machine } from "./Machine.js";
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

      if (!transition) {
        continue;
      }

      // Compute new state
      const newStateResult = transition.handler({ state: currentState, event });
      let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

      // Run transition effect if any (for side effects during test)
      if (transition.effect) {
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
 * Create a controllable test harness for a machine
 */
export interface TestHarness<S, E, R> {
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  readonly send: (event: E) => Effect.Effect<S, never, R>;
  readonly getState: Effect.Effect<S>;
}

/**
 * Create a test harness for step-by-step testing.
 * Does not run onEnter/onExit effects, but does apply always transitions.
 */
export const createTestHarness = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
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

        if (!transition) {
          return currentState;
        }

        const newStateResult = transition.handler({ state: currentState, event });
        let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

        if (transition.effect) {
          yield* transition.effect({ state: currentState, event });
        }

        // Apply always transitions if state tag changed
        if (newState._tag !== currentState._tag) {
          newState = yield* applyAlways(machine, newState);
        }

        yield* SubscriptionRef.set(stateRef, newState);
        return newState;
      });

    return {
      state: stateRef,
      send,
      getState: SubscriptionRef.get(stateRef),
    };
  });
