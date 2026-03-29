/**
 * Shared event fold — processes events through transition handlers with postpone-drain.
 *
 * Used by simulate, createTestHarness, and Machine.replay. One implementation
 * instead of three independent postpone-drain loops.
 *
 * @internal
 */
import { Effect } from "effect";

import type { Machine, MachineRef } from "../machine.js";
import type { GuardsDef, EffectsDef } from "../slot.js";
import { executeTransition, shouldPostpone } from "./transition.js";
import type { ActorSystem } from "../actor.js";
import type { SlotHandlers } from "./slots.js";

/**
 * Fold events through a machine's transition handlers.
 *
 * Handles:
 * - Transition execution via executeTransition
 * - Postpone rules (buffer events, drain on state change)
 * - Final state detection (stops processing)
 * - State collection (all visited states)
 *
 * Does NOT run spawn effects, background effects, or timeouts.
 * self/system are stubs — transitions are pure state functions.
 *
 * @internal
 */
export const foldEvents = Effect.fn("effect-machine.foldEvents")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance for slot type params
  machine: Machine<S, E, R, GD, EFD>,
  initialState: S,
  events: ReadonlyArray<E>,
  self: MachineRef<E>,
  system: ActorSystem,
  actorId: string,
  slotHandlers?: SlotHandlers,
) {
  let currentState = initialState;
  const states: S[] = [currentState];
  const hasPostponeRules = machine.postponeRules.length > 0;
  const postponed: E[] = [];

  for (const event of events) {
    // Final state stops fold
    if (machine.finalStates.has(currentState._tag)) break;

    // Check postpone rules
    if (hasPostponeRules && shouldPostpone(machine, currentState._tag, event._tag)) {
      postponed.push(event);
      continue;
    }

    const result = yield* executeTransition(
      machine,
      currentState,
      event,
      self,
      system,
      actorId,
      slotHandlers,
    );

    if (!result.transitioned) {
      continue;
    }

    const prevTag = currentState._tag;
    currentState = result.newState;
    states.push(currentState);

    // Stop if final state
    if (machine.finalStates.has(currentState._tag)) {
      break;
    }

    // Drain postponed events after state tag change or reenter — loop until stable
    const stateChanged = currentState._tag !== prevTag || result.reenter;
    if (stateChanged && postponed.length > 0) {
      let drainTag = prevTag;
      while (currentState._tag !== drainTag && postponed.length > 0) {
        if (machine.finalStates.has(currentState._tag)) break;
        drainTag = currentState._tag;
        const drained = postponed.splice(0);
        for (const postponedEvent of drained) {
          if (machine.finalStates.has(currentState._tag)) break;
          if (shouldPostpone(machine, currentState._tag, postponedEvent._tag)) {
            postponed.push(postponedEvent);
            continue;
          }
          const drainResult = yield* executeTransition(
            machine,
            currentState,
            postponedEvent,
            self,
            system,
            actorId,
            slotHandlers,
          );
          if (drainResult.transitioned) {
            currentState = drainResult.newState;
            states.push(currentState);
            if (machine.finalStates.has(currentState._tag)) {
              break;
            }
          }
        }
      }
    }
  }

  return { states, finalState: currentState };
});
