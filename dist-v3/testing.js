import { stubSystem } from "./internal/utils.js";
import { AssertionError } from "./errors.js";
import { BuiltMachine } from "./machine.js";
import { executeTransition } from "./internal/transition.js";
import { Effect, SubscriptionRef } from "effect";

//#region src-v3/testing.ts
/**
 * Simulate a sequence of events through a machine without running an actor.
 * Useful for testing state transitions in isolation.
 * Does not run onEnter/spawn/background effects, but does run guard/effect slots
 * within transition handlers.
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
const simulate = Effect.fn("effect-machine.simulate")(function* (input, events) {
  const machine = input instanceof BuiltMachine ? input._inner : input;
  const dummySelf = {
    send: Effect.fn("effect-machine.testing.simulate.send")((_event) => Effect.void),
    spawn: () => Effect.die("spawn not supported in simulation"),
  };
  let currentState = machine.initial;
  const states = [currentState];
  for (const event of events) {
    const result = yield* executeTransition(machine, currentState, event, dummySelf, stubSystem);
    if (!result.transitioned) continue;
    currentState = result.newState;
    states.push(currentState);
    if (machine.finalStates.has(currentState._tag)) break;
  }
  return {
    states,
    finalState: currentState,
  };
});
/**
 * Assert that a machine can reach a specific state given a sequence of events
 */
const assertReaches = Effect.fn("effect-machine.assertReaches")(
  function* (input, events, expectedTag) {
    const result = yield* simulate(input, events);
    if (result.finalState._tag !== expectedTag)
      return yield* new AssertionError({
        message: `Expected final state "${expectedTag}" but got "${result.finalState._tag}". States visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
      });
    return result.finalState;
  },
);
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
const assertPath = Effect.fn("effect-machine.assertPath")(function* (input, events, expectedPath) {
  const result = yield* simulate(input, events);
  const actualPath = result.states.map((s) => s._tag);
  if (actualPath.length !== expectedPath.length)
    return yield* new AssertionError({
      message: `Path length mismatch. Expected ${expectedPath.length} states but got ${actualPath.length}.\nExpected: ${expectedPath.join(" -> ")}\nActual:   ${actualPath.join(" -> ")}`,
    });
  for (let i = 0; i < expectedPath.length; i++)
    if (actualPath[i] !== expectedPath[i])
      return yield* new AssertionError({
        message: `Path mismatch at position ${i}. Expected "${expectedPath[i]}" but got "${actualPath[i]}".\nExpected: ${expectedPath.join(" -> ")}\nActual:   ${actualPath.join(" -> ")}`,
      });
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
const assertNeverReaches = Effect.fn("effect-machine.assertNeverReaches")(
  function* (input, events, forbiddenTag) {
    const result = yield* simulate(input, events);
    const visitedIndex = result.states.findIndex((s) => s._tag === forbiddenTag);
    if (visitedIndex !== -1)
      return yield* new AssertionError({
        message: `Machine reached forbidden state "${forbiddenTag}" at position ${visitedIndex}.\nStates visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
      });
    return result;
  },
);
/**
 * Create a test harness for step-by-step testing.
 * Does not run onEnter/spawn/background effects, but does run guard/effect slots
 * within transition handlers.
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
const createTestHarness = Effect.fn("effect-machine.createTestHarness")(function* (input, options) {
  const machine = input instanceof BuiltMachine ? input._inner : input;
  const dummySelf = {
    send: Effect.fn("effect-machine.testing.harness.send")((_event) => Effect.void),
    spawn: () => Effect.die("spawn not supported in test harness"),
  };
  const stateRef = yield* SubscriptionRef.make(machine.initial);
  return {
    state: stateRef,
    send: Effect.fn("effect-machine.testHarness.send")(function* (event) {
      const currentState = yield* SubscriptionRef.get(stateRef);
      const result = yield* executeTransition(machine, currentState, event, dummySelf, stubSystem);
      if (!result.transitioned) return currentState;
      const newState = result.newState;
      yield* SubscriptionRef.set(stateRef, newState);
      if (options?.onTransition !== void 0) options.onTransition(currentState, event, newState);
      return newState;
    }),
    getState: SubscriptionRef.get(stateRef),
  };
});

//#endregion
export {
  AssertionError,
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
};
