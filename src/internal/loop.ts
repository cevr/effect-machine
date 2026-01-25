import { Effect, Fiber, Queue, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef } from "../machine.js";

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
    if (!transition.guard || transition.guard({ state: currentState, event })) {
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
    if (!transition.guard || transition.guard(currentState)) {
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
      if (!transition) {
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

    // Create self reference for sending events
    const self: MachineRef<E> = {
      send: (event) => Queue.offer(eventQueue, event),
    };

    // Run initial entry effects
    yield* runEntryEffects(machine, resolvedInitial, self);

    // Check if initial state (after always) is final
    if (machine.finalStates.has(resolvedInitial._tag)) {
      // Create actor ref but don't start loop
      const actorRef: ActorRef<S, E> = {
        id,
        send: (event) => Queue.offer(eventQueue, event),
        state: stateRef,
        stop: Effect.gen(function* () {
          yield* Queue.shutdown(eventQueue);
        }).pipe(Effect.asVoid),
      };
      return actorRef;
    }

    // Start the event loop
    const loopFiber = yield* Effect.fork(eventLoop(machine, stateRef, eventQueue, self));

    // Create the actor ref
    const actorRef: ActorRef<S, E> = {
      id,
      send: (event) => Queue.offer(eventQueue, event),
      state: stateRef,
      stop: Effect.gen(function* () {
        yield* Queue.shutdown(eventQueue);
        yield* Fiber.interrupt(loopFiber);
      }).pipe(Effect.asVoid),
    };

    return actorRef;
  });

/**
 * Main event loop for the actor
 */
const eventLoop = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    while (true) {
      // Block waiting for next event - will fail with QueueShutdown when queue is shut down
      const event = yield* Queue.take(eventQueue);

      const currentState = yield* SubscriptionRef.get(stateRef);

      // Find matching transition using guard cascade
      const transition = resolveTransition(machine, currentState, event);

      if (!transition) {
        // No transition for this state/event pair - ignore
        continue;
      }

      // Compute new state
      const newStateResult = transition.handler({ state: currentState, event });
      let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

      // Run transition effect if any
      if (transition.effect) {
        yield* transition.effect({ state: currentState, event });
      }

      // Check if state actually changed
      if (newState._tag !== currentState._tag) {
        // Run exit effects for old state
        yield* runExitEffects(machine, currentState, self);

        // Apply always transitions
        newState = yield* applyAlways(machine, newState);

        // Update state
        yield* SubscriptionRef.set(stateRef, newState);

        // Run entry effects for new state
        yield* runEntryEffects(machine, newState, self);

        // Check if new state is final
        if (machine.finalStates.has(newState._tag)) {
          return;
        }
      } else {
        // Same state tag, just update
        yield* SubscriptionRef.set(stateRef, newState);
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
