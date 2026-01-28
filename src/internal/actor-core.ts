/**
 * Shared actor building utilities.
 * @internal
 */
import { Effect, Queue, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef } from "../machine.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { resolveTransition } from "./loop.js";

/** Listener set for sync subscriptions */
export type Listeners<S> = Set<(state: S) => void>;

/** Create machine context for slot accessors */
export const createMachineContext = <S, E>(
  state: S,
  event: E,
  self: MachineRef<E>,
): MachineContext<S, E, MachineRef<E>> => ({
  state,
  event,
  self,
});

/**
 * Notify all listeners of state change.
 */
export const notifyListeners = <S>(listeners: Listeners<S>, state: S): void => {
  for (const listener of listeners) {
    listener(state);
  }
};

/**
 * Build core ActorRef methods shared between regular and persistent actors.
 */
export const buildActorRefCore = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
): ActorRef<S, E> =>
  ({
    id,
    send: (event) => Queue.offer(eventQueue, event),
    state: stateRef,
    stop,
    snapshot: SubscriptionRef.get(stateRef),
    snapshotSync: () => Effect.runSync(SubscriptionRef.get(stateRef)),
    matches: (tag) => Effect.map(SubscriptionRef.get(stateRef), (s) => s._tag === tag),
    matchesSync: (tag) => Effect.runSync(SubscriptionRef.get(stateRef))._tag === tag,
    can: (event) =>
      Effect.map(
        SubscriptionRef.get(stateRef),
        (s) => resolveTransition(machine, s, event) !== undefined,
      ),
    canSync: (event) => {
      const state = Effect.runSync(SubscriptionRef.get(stateRef));
      return resolveTransition(machine, state, event) !== undefined;
    },
    changes: stateRef.changes,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  });
