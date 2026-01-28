import { Effect, SubscriptionRef } from "effect";

import type { Machine, MachineRef, HandlerContext } from "./machine.js";
import { resolveTransition } from "./internal/loop.js";
import { AssertionError } from "./errors.js";
import type { GuardsDef, EffectsDef, MachineContext } from "./slot.js";
import { isEffect } from "./internal/is-effect.js";

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
export const simulate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  events: ReadonlyArray<E>,
): Effect.Effect<SimulationResult<S>, never, R> =>
  Effect.gen(function* () {
    // Create a dummy self for slot accessors
    const dummySelf: MachineRef<E> = {
      send: () => Effect.void,
    };

    let currentState = machine.initial;
    const states: S[] = [currentState];

    for (const event of events) {
      // Use shared resolver for transition lookup
      const transition = yield* resolveTransition(machine, currentState, event);

      if (transition === undefined) {
        continue;
      }

      // Create context for handler
      const ctx: MachineContext<S, E, MachineRef<E>> = {
        state: currentState,
        event,
        self: dummySelf,
      };
      const { guards, effects } = machine._createSlotAccessors(ctx);

      const handlerCtx: HandlerContext<S, E, GD, EFD> = {
        state: currentState,
        event,
        guards,
        effects,
      };

      // Compute new state
      const newStateResult = transition.handler(handlerCtx);
      let newState = isEffect(newStateResult)
        ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
            Effect.provideService(machine.Context, ctx),
          )
        : newStateResult;

      currentState = newState;
      states.push(currentState);

      // Stop if final state
      if (machine.finalStates.has(currentState._tag)) {
        break;
      }
    }

    return { states, finalState: currentState };
  });

// AssertionError is exported from errors.ts
export { AssertionError } from "./errors.js";

/**
 * Assert that a machine can reach a specific state given a sequence of events
 */
export const assertReaches = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  events: ReadonlyArray<E>,
  expectedTag: string,
): Effect.Effect<S, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);
    if (result.finalState._tag !== expectedTag) {
      return yield* new AssertionError({
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
export const assertPath = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  events: ReadonlyArray<E>,
  expectedPath: ReadonlyArray<string>,
): Effect.Effect<SimulationResult<S>, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);
    const actualPath = result.states.map((s) => s._tag);

    if (actualPath.length !== expectedPath.length) {
      return yield* new AssertionError({
        message:
          `Path length mismatch. Expected ${expectedPath.length} states but got ${actualPath.length}.\n` +
          `Expected: ${expectedPath.join(" -> ")}\n` +
          `Actual:   ${actualPath.join(" -> ")}`,
      });
    }

    for (let i = 0; i < expectedPath.length; i++) {
      if (actualPath[i] !== expectedPath[i]) {
        return yield* new AssertionError({
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
export const assertNeverReaches = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  events: ReadonlyArray<E>,
  forbiddenTag: string,
): Effect.Effect<SimulationResult<S>, AssertionError, R> =>
  Effect.gen(function* () {
    const result = yield* simulate(machine, events);

    const visitedIndex = result.states.findIndex((s) => s._tag === forbiddenTag);
    if (visitedIndex !== -1) {
      return yield* new AssertionError({
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
export interface TestHarness<S, E, R, _GD extends GuardsDef, _EFD extends EffectsDef> {
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
export const createTestHarness = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  options?: TestHarnessOptions<S, E>,
): Effect.Effect<TestHarness<S, E, R, GD, EFD>, never, R> =>
  Effect.gen(function* () {
    // Create a dummy self for slot accessors
    const dummySelf: MachineRef<E> = {
      send: () => Effect.void,
    };

    const stateRef = yield* SubscriptionRef.make(machine.initial);

    const send = (event: E): Effect.Effect<S, never, R> =>
      Effect.gen(function* () {
        const currentState = yield* SubscriptionRef.get(stateRef);

        // Use shared resolver for transition lookup
        const transition = yield* resolveTransition(machine, currentState, event);

        if (transition === undefined) {
          return currentState;
        }

        // Create context for handler
        const ctx: MachineContext<S, E, MachineRef<E>> = {
          state: currentState,
          event,
          self: dummySelf,
        };
        const { guards, effects } = machine._createSlotAccessors(ctx);

        const handlerCtx: HandlerContext<S, E, GD, EFD> = {
          state: currentState,
          event,
          guards,
          effects,
        };

        const newStateResult = transition.handler(handlerCtx);
        let newState = isEffect(newStateResult)
          ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
              Effect.provideService(machine.Context, ctx),
            )
          : newStateResult;

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
