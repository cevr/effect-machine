import { AssertionError } from "./errors.js";
import { EffectsDef, GuardsDef } from "./slot.js";
import { BuiltMachine, Machine } from "./machine.js";
import { Effect, SubscriptionRef } from "effect";

//#region src-v3/testing.d.ts
/** Accept either Machine or BuiltMachine for testing utilities. */
type MachineInput<S, E, R, GD extends GuardsDef, EFD extends EffectsDef> =
  | Machine<S, E, R, any, any, GD, EFD>
  | BuiltMachine<S, E, R>;
/**
 * Result of simulating events through a machine
 */
interface SimulationResult<S> {
  readonly states: ReadonlyArray<S>;
  readonly finalState: S;
}
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
declare const simulate: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: MachineInput<S, E, R, GD, EFD>,
  events: readonly E[],
) => Effect.Effect<
  {
    states: S[];
    finalState: S;
  },
  never,
  Exclude<R, unknown>
>;
/**
 * Assert that a machine can reach a specific state given a sequence of events
 */
declare const assertReaches: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: MachineInput<S, E, R, GD, EFD>,
  events: readonly E[],
  expectedTag: string,
) => Effect.Effect<any, unknown, unknown>;
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
declare const assertPath: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: MachineInput<S, E, R, GD, EFD>,
  events: readonly E[],
  expectedPath: readonly string[],
) => Effect.Effect<any, unknown, unknown>;
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
declare const assertNeverReaches: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: MachineInput<S, E, R, GD, EFD>,
  events: readonly E[],
  forbiddenTag: string,
) => Effect.Effect<any, unknown, unknown>;
/**
 * Create a controllable test harness for a machine
 */
interface TestHarness<S, E, R> {
  readonly state: SubscriptionRef.SubscriptionRef<S>;
  readonly send: (event: E) => Effect.Effect<S, never, R>;
  readonly getState: Effect.Effect<S>;
}
/**
 * Options for creating a test harness
 */
interface TestHarnessOptions<S, E> {
  /**
   * Called after each transition with the previous state, event, and new state.
   * Useful for logging or spying on transitions.
   */
  readonly onTransition?: (from: S, event: E, to: S) => void;
}
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
declare const createTestHarness: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: MachineInput<S, E, R, GD, EFD>,
  options?: TestHarnessOptions<S, E> | undefined,
) => Effect.Effect<
  {
    state: SubscriptionRef.SubscriptionRef<S>;
    send: (event: E) => Effect.Effect<S, never, never>;
    getState: Effect.Effect<S, never, never>;
  },
  never,
  never
>;
//#endregion
export {
  AssertionError,
  SimulationResult,
  TestHarness,
  TestHarnessOptions,
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
};
