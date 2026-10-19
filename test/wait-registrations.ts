import type { SubscriptionRef } from "effect";

import { liveStateRegistrations } from "../src/actor.js";

/**
 * Count what the actor that owns `state` holds for its listeners and waits: its state
 * listeners and terminal wake-ups, plus each open subscription to the state's publication
 * made from now on. Compare a later count with one taken before the waits under test.
 */
export const trackRegistrations = <S>(
  state: SubscriptionRef.SubscriptionRef<S>,
): (() => number) => {
  const atomic = state.pubsub.pubsub;
  const subscribe = atomic.subscribe.bind(atomic);
  let subscriptions = 0;
  atomic.subscribe = () => {
    const backing = subscribe();
    const unsubscribe = backing.unsubscribe.bind(backing);
    let open = true;
    subscriptions += 1;
    backing.unsubscribe = () => {
      if (open) {
        open = false;
        subscriptions -= 1;
      }
      unsubscribe();
    };
    return backing;
  };
  return () => subscriptions + liveStateRegistrations(state);
};
