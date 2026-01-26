import { Effect, Fiber, Queue, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef } from "../machine.js";

/** Listener set for sync subscriptions */
type Listeners<S> = Set<(state: S) => void>;

/** Maximum steps for always transitions to prevent infinite loops */
const MAX_ALWAYS_STEPS = 100;

/**
 * Resolve which transition should fire for a given state and event.
 * Iterates transitions in registration order; first guard pass wins.
 */
export const resolveTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  currentState: S,
  event: E,
): Machine<S, E, R>["transitions"][number] | undefined => {
  for (const transition of machine.transitions) {
    if (transition.stateTag !== currentState._tag || transition.eventTag !== event._tag) {
      continue;
    }
    // If no guard, or guard passes, this transition wins
    if (transition.guard === undefined || transition.guard({ state: currentState, event })) {
      return transition;
    }
    // Guard failed - continue to next transition (guard cascade)
  }
  return undefined;
};

/**
 * Resolve which always transition should fire for the current state.
 * Iterates always transitions in registration order; first guard pass wins.
 */
export const resolveAlwaysTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  currentState: S,
): Machine<S, E, R>["alwaysTransitions"][number] | undefined => {
  for (const transition of machine.alwaysTransitions) {
    if (transition.stateTag !== currentState._tag) {
      continue;
    }
    // If no guard, or guard passes, this transition wins
    if (transition.guard === undefined || transition.guard(currentState)) {
      return transition;
    }
  }
  return undefined;
};

/**
 * Apply always transitions until none match or max steps reached.
 * Returns the final state after all always transitions are applied.
 */
export const applyAlways = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  state: S,
): Effect.Effect<S, never, R> =>
  Effect.gen(function* () {
    let currentState = state;
    let steps = 0;

    while (steps < MAX_ALWAYS_STEPS) {
      const transition = resolveAlwaysTransition(machine, currentState);
      if (transition === undefined) {
        break;
      }

      const newStateResult = transition.handler(currentState);
      const newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

      // If state didn't change, stop (prevent infinite loops)
      if (newState._tag === currentState._tag && newState === currentState) {
        break;
      }

      currentState = newState;
      steps++;
    }

    if (steps >= MAX_ALWAYS_STEPS) {
      yield* Effect.logWarning(
        `[effect-machine] Max always transition steps (${MAX_ALWAYS_STEPS}) reached. Possible infinite loop.`,
      );
    }

    return currentState;
  });

/**
 * Build ActorRef with all methods
 */
const buildActorRef = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  id: string,
  machine: Machine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
): ActorRef<S, E> => ({
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

/**
 * Notify all listeners of state change
 */
const notifyListeners = <S>(listeners: Listeners<S>, state: S): void => {
  for (const listener of listeners) {
    listener(state);
  }
};

/**
 * Create and start an actor for a machine
 */
export const createActor = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  id: string,
  machine: Machine<S, E, R>,
): Effect.Effect<ActorRef<S, E>, never, R> =>
  Effect.gen(function* () {
    // Apply always transitions to initial state
    const resolvedInitial = yield* applyAlways(machine, machine.initial);

    // Initialize state
    const stateRef = yield* SubscriptionRef.make(resolvedInitial);
    const eventQueue = yield* Queue.unbounded<E>();
    const listeners: Listeners<S> = new Set();

    // Create self reference for sending events
    const self: MachineRef<E> = {
      send: (event) => Queue.offer(eventQueue, event),
    };

    // Run initial entry effects
    yield* runEntryEffects(machine, resolvedInitial, self);

    // Check if initial state (after always) is final
    if (machine.finalStates.has(resolvedInitial._tag)) {
      return buildActorRef(
        id,
        machine,
        stateRef,
        eventQueue,
        listeners,
        Queue.shutdown(eventQueue).pipe(Effect.asVoid),
      );
    }

    // Start the event loop
    const loopFiber = yield* Effect.fork(eventLoop(machine, stateRef, eventQueue, self, listeners));

    return buildActorRef(
      id,
      machine,
      stateRef,
      eventQueue,
      listeners,
      Effect.gen(function* () {
        yield* Queue.shutdown(eventQueue);
        yield* Fiber.interrupt(loopFiber);
      }).pipe(Effect.asVoid),
    );
  });

/**
 * Main event loop for the actor
 */
const eventLoop = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    while (true) {
      // Block waiting for next event - will fail with QueueShutdown when queue is shut down
      const event = yield* Queue.take(eventQueue);

      const currentState = yield* SubscriptionRef.get(stateRef);

      // Find matching transition using guard cascade
      const transition = resolveTransition(machine, currentState, event);

      if (transition === undefined) {
        // No transition for this state/event pair - ignore
        continue;
      }

      // Compute new state
      const newStateResult = transition.handler({ state: currentState, event });
      let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

      // Run transition effect if any
      if (transition.effect !== undefined) {
        yield* transition.effect({ state: currentState, event });
      }

      // Determine if we should run exit/enter effects
      const stateTagChanged = newState._tag !== currentState._tag;
      // Run lifecycle if:
      // - State tag changed (always run exit/enter)
      // - reenter=true (force lifecycle even for same tag)
      const runLifecycle = stateTagChanged || transition.reenter === true;

      if (runLifecycle) {
        // Run exit effects for old state
        yield* runExitEffects(machine, currentState, self);

        // Apply always transitions (only if tag changed)
        if (stateTagChanged) {
          newState = yield* applyAlways(machine, newState);
        }

        // Update state
        yield* SubscriptionRef.set(stateRef, newState);
        notifyListeners(listeners, newState);

        // Run entry effects for new state
        yield* runEntryEffects(machine, newState, self);

        // Check if new state is final
        if (machine.finalStates.has(newState._tag)) {
          notifyListeners(listeners, newState);
          return;
        }
      } else {
        // Same state tag without reenter - just update state
        yield* SubscriptionRef.set(stateRef, newState);
        notifyListeners(listeners, newState);
      }
    }
  });

/**
 * Run entry effects for a state
 */
const runEntryEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  state: S,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = machine.onEnter.filter((e) => e.stateTag === state._tag);
    for (const effect of effects) {
      yield* effect.handler({ state, self });
    }
  });

/**
 * Run exit effects for a state
 */
const runExitEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  state: S,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = machine.onExit.filter((e) => e.stateTag === state._tag);
    for (const effect of effects) {
      yield* effect.handler({ state, self });
    }
  });
