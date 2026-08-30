import { Effect, SubscriptionRef } from "effect";

import type { Machine } from "./machine.js";
import { AssertionError } from "./errors.js";
import { makeEventAdvancement } from "./internal/event-advancement.js";
import { executeTransition, shouldPostpone } from "./internal/transition.js";
import { INTERNAL_INIT_EVENT } from "./internal/utils.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MachineInput<S, E, R, Input = void> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Machine<S, E, R, any, any, Input, any>;

export type SimulationOptions<Input> = [Input] extends [void]
  ? { readonly input?: never }
  : { readonly input: Input };

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
 * Does not run task, spawn, or background effects.
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
const simulateImpl = Effect.fn("effect-machine.simulate")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  Input,
>(
  input: MachineInput<S, E, R, Input>,
  events: ReadonlyArray<E>,
  options?: SimulationOptions<Input>,
) {
  const machine = input;
  const machineInitial = machine._initial(options?.input);
  // eslint-disable-next-line effect/noAs -- internal eventless-transition sentinel
  const initial = yield* executeTransition(machine, machineInitial, {
    _tag: INTERNAL_INIT_EVENT,
  } as E);
  const states: S[] = [initial.newState];
  if (!machine._hasPostponeRules()) {
    let state = initial.newState;
    for (const event of events) {
      if (machine._isFinal(state._tag)) break;
      const result = yield* executeTransition(machine, state, event);
      if (result.transitioned) {
        state = result.newState;
        states.push(state);
      }
    }
    return { states, finalState: state };
  }

  const advancement = makeEventAdvancement({
    initial: initial.newState,
    isFinal: (state: S) => machine._isFinal(state._tag),
    shouldPostpone: (state: S, event: E) => shouldPostpone(machine, state._tag, event._tag),
    postpone: (_state: S, event: E) => Effect.succeed({ input: event, value: undefined }),
    process: (state: S, event: E) =>
      executeTransition(machine, state, event).pipe(
        Effect.map((result) => {
          if (result.transitioned) states.push(result.newState);
          return {
            state: result.newState,
            transitioned: result.transitioned,
            stateChanged:
              result.transitioned && (result.newState._tag !== state._tag || result.reenter),
            shouldStop: result.transitioned && machine._isFinal(result.newState._tag),
            value: undefined,
          };
        }),
      ),
  });

  for (const event of events) {
    yield* advancement.advance(event);
  }

  return { states, finalState: advancement.state };
});

// @effect-diagnostics missingPipeableSignature:off -- conditional input overloads are data-first
export const simulate: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    input: MachineInput<S, E, R, void>,
    events: ReadonlyArray<E>,
    options?: SimulationOptions<void>,
  ): Effect.Effect<SimulationResult<S>, never, R>;
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, Input>(
    input: MachineInput<S, E, R, Input>,
    events: ReadonlyArray<E>,
    options: SimulationOptions<Input>,
  ): Effect.Effect<SimulationResult<S>, never, R>;
} = simulateImpl;
// @effect-diagnostics missingPipeableSignature:on

// AssertionError is exported from errors.ts
export { AssertionError } from "./errors.js";

/**
 * Assert that a machine can reach a specific state given a sequence of events
 */
export const assertReaches = Effect.fn("effect-machine.assertReaches")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(input: MachineInput<S, E, R>, events: ReadonlyArray<E>, expectedTag: string) {
  const result = yield* simulate(input, events);
  if (result.finalState._tag !== expectedTag) {
    return yield* AssertionError.make({
      message:
        `Expected final state "${expectedTag}" but got "${result.finalState._tag}". ` +
        `States visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
    });
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
export const assertPath = Effect.fn("effect-machine.assertPath")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(input: MachineInput<S, E, R>, events: ReadonlyArray<E>, expectedPath: ReadonlyArray<string>) {
  const result = yield* simulate(input, events);
  const actualPath = result.states.map((s) => s._tag);

  if (actualPath.length !== expectedPath.length) {
    return yield* AssertionError.make({
      message:
        `Path length mismatch. Expected ${expectedPath.length} states but got ${actualPath.length}.\n` +
        `Expected: ${expectedPath.join(" -> ")}\n` +
        `Actual:   ${actualPath.join(" -> ")}`,
    });
  }

  for (let i = 0; i < expectedPath.length; i++) {
    if (actualPath[i] !== expectedPath[i]) {
      return yield* AssertionError.make({
        message:
          `Path mismatch at position ${i}. Expected "${expectedPath[i]}" but got "${actualPath[i]}".\n` +
          `Expected: ${expectedPath.join(" -> ")}\n` +
          `Actual:   ${actualPath.join(" -> ")}`,
      });
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
export const assertNeverReaches = Effect.fn("effect-machine.assertNeverReaches")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(input: MachineInput<S, E, R>, events: ReadonlyArray<E>, forbiddenTag: string) {
  const result = yield* simulate(input, events);

  const visitedIndex = result.states.findIndex((s) => s._tag === forbiddenTag);
  if (visitedIndex !== -1) {
    return yield* AssertionError.make({
      message:
        `Machine reached forbidden state "${forbiddenTag}" at position ${visitedIndex}.\n` +
        `States visited: ${result.states.map((s) => s._tag).join(" -> ")}`,
    });
  }

  return result;
});

/**
 * Create a controllable test harness for a machine
 */
export interface TestHarness<S, E> {
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  readonly send: (event: E) => Effect.Effect<S>;
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

export type InputTestHarnessOptions<S, E, Input> = TestHarnessOptions<S, E> &
  ([Input] extends [void] ? { readonly input?: never } : { readonly input: Input });

/**
 * Create a test harness for step-by-step testing.
 * Does not run task, spawn, or background effects.
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
const createTestHarnessImpl = Effect.fn("effect-machine.createTestHarness")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  Input,
>(input: MachineInput<S, E, R, Input>, options?: InputTestHarnessOptions<S, E, Input>) {
  const machine = input;
  const machineInitial = machine._initial(options?.input);
  // eslint-disable-next-line effect/noAs -- internal eventless-transition sentinel
  const initial = yield* executeTransition(machine, machineInitial, {
    _tag: INTERNAL_INIT_EVENT,
  } as E);
  const stateRef = yield* SubscriptionRef.make(initial.newState);
  const advancement = makeEventAdvancement({
    initial: initial.newState,
    isFinal: (state: S) => machine._isFinal(state._tag),
    shouldPostpone: (state: S, event: E) => shouldPostpone(machine, state._tag, event._tag),
    postpone: (state: S, event: E) => Effect.succeed({ input: event, value: state }),
    process: (state: S, event: E) =>
      executeTransition(machine, state, event).pipe(
        Effect.map((result) => ({
          state: result.newState,
          transitioned: result.transitioned,
          stateChanged:
            result.transitioned && (result.newState._tag !== state._tag || result.reenter),
          shouldStop: result.transitioned && machine._isFinal(result.newState._tag),
          value: result.newState,
        })),
      ),
    commit: (state: S, event: E, step) => {
      if (!step.transitioned) return Effect.void;
      return SubscriptionRef.set(stateRef, step.state).pipe(
        Effect.tap(() => Effect.sync(() => options?.onTransition?.(state, event, step.state))),
      );
    },
  });
  const send = Effect.fn("effect-machine.testHarness.send")(function* (event: E) {
    const result = yield* advancement.advance(event);
    return result.state;
  });

  return {
    state: stateRef,
    send,
    getState: SubscriptionRef.get(stateRef),
  };
});

// @effect-diagnostics missingPipeableSignature:off -- conditional input overloads are data-first
export const createTestHarness: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    input: MachineInput<S, E, R, void>,
    options?: InputTestHarnessOptions<S, E, void>,
  ): Effect.Effect<TestHarness<S, E>, never, R>;
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, Input>(
    input: MachineInput<S, E, R, Input>,
    options: InputTestHarnessOptions<S, E, Input>,
  ): Effect.Effect<TestHarness<S, E>, never, R>;
} = createTestHarnessImpl;
// @effect-diagnostics missingPipeableSignature:on
