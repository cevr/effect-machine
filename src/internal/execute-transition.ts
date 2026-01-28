/**
 * Shared transition execution logic for processEvent, simulate, and createTestHarness.
 *
 * @internal
 */
import { Effect } from "effect";

import type { Machine, MachineRef, HandlerContext } from "../machine.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { resolveTransition } from "./loop.js";
import { isEffect } from "./is-effect.js";

/**
 * Result of executing a transition.
 */
export interface TransitionExecutionResult<S> {
  /** New state after transition (or current state if no transition matched) */
  readonly newState: S;
  /** Whether a transition was executed */
  readonly transitioned: boolean;
  /** Whether reenter was specified on the transition */
  readonly reenter: boolean;
}

/**
 * Execute a transition for a given state and event.
 * Handles transition resolution, handler invocation, and guard/effect slot creation.
 *
 * Used by:
 * - processEvent in loop.ts (actual actor event loop)
 * - simulate in testing.ts (pure transition simulation)
 * - createTestHarness.send in testing.ts (step-by-step testing)
 *
 * @internal
 */
export const executeTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
): Effect.Effect<TransitionExecutionResult<S>, never, R> =>
  Effect.gen(function* () {
    // Find matching transition
    const transition = yield* resolveTransition(machine, currentState, event);

    if (transition === undefined) {
      return {
        newState: currentState,
        transitioned: false,
        reenter: false,
      };
    }

    // Create context for handler
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state: currentState,
      event,
      self,
    };
    const { guards, effects } = machine._createSlotAccessors(ctx);

    const handlerCtx: HandlerContext<S, E, GD, EFD> = {
      state: currentState,
      event,
      guards,
      effects,
    };

    // Compute new state - provide machine context for slot handlers
    const newStateResult = transition.handler(handlerCtx);
    const newState = isEffect(newStateResult)
      ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
          Effect.provideService(machine.Context, ctx),
        )
      : newStateResult;

    return {
      newState,
      transitioned: true,
      reenter: transition.reenter === true,
    };
  });
