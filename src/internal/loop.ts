import { Effect, Fiber, Option, Queue, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef } from "../machine.js";
import type { InspectionEvent, Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import {
  findTransitions,
  findAlwaysTransitions,
  findOnEnterEffects,
  findOnExitEffects,
} from "./transition-index.js";

/** Listener set for sync subscriptions */
type Listeners<S> = Set<(state: S) => void>;

/** Maximum steps for always transitions to prevent infinite loops */
const MAX_ALWAYS_STEPS = 100;

// ============================================================================
// Inspection Helpers
// ============================================================================

/** Emit an inspection event if inspector is available */
const emit = <S, E>(inspector: Inspector<S, E> | undefined, event: InspectionEvent<S, E>): void => {
  inspector?.onInspect(event);
};

/** Get current timestamp */
const now = (): number => Date.now();

/**
 * Resolve which transition should fire for a given state and event.
 * Uses indexed O(1) lookup, then evaluates guards in registration order.
 * First guard pass wins.
 */
export const resolveTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  currentState: S,
  event: E,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Machine<S, E, R>["transitions"][number] | undefined => {
  const candidates = findTransitions(machine, currentState._tag, event._tag);

  let guardIndex = 0;
  for (const transition of candidates) {
    // If no guard, this transition wins
    if (transition.guard === undefined) {
      return transition;
    }

    // Evaluate guard and emit inspection event
    const result = transition.guard({ state: currentState, event });

    if (actorId !== undefined && inspector !== undefined) {
      emit(inspector, {
        type: "@machine.guard",
        actorId,
        state: currentState,
        event,
        guardName: transition.guardName,
        guardIndex,
        result,
        timestamp: now(),
      });
    }

    if (result) {
      return transition;
    }

    // Guard failed - continue to next transition (guard cascade)
    guardIndex++;
  }
  return undefined;
};

/**
 * Resolve which always transition should fire for the current state.
 * Uses indexed O(1) lookup, then evaluates guards in registration order.
 * First guard pass wins.
 */
export const resolveAlwaysTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  currentState: S,
): Machine<S, E, R>["alwaysTransitions"][number] | undefined => {
  const candidates = findAlwaysTransitions(machine, currentState._tag);

  for (const transition of candidates) {
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
  Effect.withSpan("effect-machine.actor.spawn", {
    attributes: { "effect_machine.actor.id": id },
  })(
    Effect.gen(function* () {
      // Get optional inspector from context
      const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
        | Inspector<S, E>
        | undefined;

      // Apply always transitions to initial state
      const resolvedInitial = yield* applyAlways(machine, machine.initial);

      // Annotate span with initial state
      yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", resolvedInitial._tag);

      // Emit spawn event
      if (inspectorValue !== undefined) {
        emit(inspectorValue, {
          type: "@machine.spawn",
          actorId: id,
          initialState: resolvedInitial,
          timestamp: now(),
        });
      }

      // Initialize state
      const stateRef = yield* SubscriptionRef.make(resolvedInitial);
      const eventQueue = yield* Queue.unbounded<E>();
      const listeners: Listeners<S> = new Set();

      // Create self reference for sending events
      const self: MachineRef<E> = {
        send: (event) => Queue.offer(eventQueue, event),
      };

      // Run initial entry effects
      yield* runEntryEffects(machine, resolvedInitial, self, id, inspectorValue);

      // Check if initial state (after always) is final
      if (machine.finalStates.has(resolvedInitial._tag)) {
        if (inspectorValue !== undefined) {
          emit(inspectorValue, {
            type: "@machine.stop",
            actorId: id,
            finalState: resolvedInitial,
            timestamp: now(),
          });
        }
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
      const loopFiber = yield* Effect.fork(
        eventLoop(machine, stateRef, eventQueue, self, listeners, id, inspectorValue),
      );

      return buildActorRef(
        id,
        machine,
        stateRef,
        eventQueue,
        listeners,
        Effect.gen(function* () {
          const finalState = yield* SubscriptionRef.get(stateRef);
          if (inspectorValue !== undefined) {
            emit(inspectorValue, {
              type: "@machine.stop",
              actorId: id,
              finalState,
              timestamp: now(),
            });
          }
          yield* Queue.shutdown(eventQueue);
          yield* Fiber.interrupt(loopFiber);
        }).pipe(Effect.asVoid),
      );
    }),
  );

/**
 * Main event loop for the actor
 */
const eventLoop = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  actorId: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    while (true) {
      // Block waiting for next event - will fail with QueueShutdown when queue is shut down
      const event = yield* Queue.take(eventQueue);

      const currentState = yield* SubscriptionRef.get(stateRef);

      // Process event in a span
      const shouldStop = yield* Effect.withSpan("effect-machine.event.process", {
        attributes: {
          "effect_machine.actor.id": actorId,
          "effect_machine.state.current": currentState._tag,
          "effect_machine.event.type": event._tag,
        },
      })(processEvent(machine, currentState, event, stateRef, self, listeners, actorId, inspector));

      if (shouldStop) {
        return;
      }
    }
  });

/**
 * Process a single event, returning true if the actor should stop
 */
const processEvent = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  currentState: S,
  event: E,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  actorId: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<boolean, never, R> =>
  Effect.gen(function* () {
    // Emit event received
    if (inspector !== undefined) {
      emit(inspector, {
        type: "@machine.event",
        actorId,
        state: currentState,
        event,
        timestamp: now(),
      });
    }

    // Find matching transition using guard cascade
    const transition = resolveTransition(machine, currentState, event, actorId, inspector);

    if (transition === undefined) {
      // No transition for this state/event pair - ignore
      yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
      return false;
    }

    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);

    // Compute new state
    const newStateResult = transition.handler({ state: currentState, event });
    let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

    // Run transition effect if any
    if (transition.effect !== undefined) {
      if (inspector !== undefined) {
        emit(inspector, {
          type: "@machine.effect",
          actorId,
          effectType: "transition",
          state: currentState,
          timestamp: now(),
        });
      }
      yield* Effect.withSpan("effect-machine.effect.transition", {
        attributes: { "effect_machine.state": currentState._tag },
      })(transition.effect({ state: currentState, event }));
    }

    // Determine if we should run exit/enter effects
    const stateTagChanged = newState._tag !== currentState._tag;
    // Run lifecycle if:
    // - State tag changed (always run exit/enter)
    // - reenter=true (force lifecycle even for same tag)
    const runLifecycle = stateTagChanged || transition.reenter === true;

    if (runLifecycle) {
      // Run exit effects for old state
      yield* runExitEffects(machine, currentState, self, actorId, inspector);

      // Apply always transitions (only if tag changed)
      if (stateTagChanged) {
        newState = yield* applyAlways(machine, newState);
      }

      yield* Effect.annotateCurrentSpan("effect_machine.state.from", currentState._tag);
      yield* Effect.annotateCurrentSpan("effect_machine.state.to", newState._tag);
      yield* Effect.annotateCurrentSpan(
        "effect_machine.transition.reenter",
        transition.reenter ?? false,
      );

      // Emit transition event
      if (inspector !== undefined) {
        emit(inspector, {
          type: "@machine.transition",
          actorId,
          fromState: currentState,
          toState: newState,
          event,
          timestamp: now(),
        });
      }

      // Update state
      yield* SubscriptionRef.set(stateRef, newState);
      notifyListeners(listeners, newState);

      // Run entry effects for new state
      yield* runEntryEffects(machine, newState, self, actorId, inspector);

      // Check if new state is final
      if (machine.finalStates.has(newState._tag)) {
        if (inspector !== undefined) {
          emit(inspector, {
            type: "@machine.stop",
            actorId,
            finalState: newState,
            timestamp: now(),
          });
        }
        notifyListeners(listeners, newState);
        return true; // Stop the loop
      }
    } else {
      // Same state tag without reenter - just update state
      yield* SubscriptionRef.set(stateRef, newState);
      notifyListeners(listeners, newState);
    }

    return false;
  });

/**
 * Run entry effects for a state
 */
export const runEntryEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  state: S,
  self: MachineRef<E>,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = findOnEnterEffects(machine, state._tag);
    for (const effect of effects) {
      if (actorId !== undefined && inspector !== undefined) {
        emit(inspector, {
          type: "@machine.effect",
          actorId,
          effectType: "entry",
          state,
          timestamp: now(),
        });
      }
      yield* Effect.withSpan("effect-machine.effect.entry", {
        attributes: { "effect_machine.state": state._tag },
      })(effect.handler({ state, self }));
    }
  });

/**
 * Run exit effects for a state
 */
export const runExitEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  state: S,
  self: MachineRef<E>,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = findOnExitEffects(machine, state._tag);
    for (const effect of effects) {
      if (actorId !== undefined && inspector !== undefined) {
        emit(inspector, {
          type: "@machine.effect",
          actorId,
          effectType: "exit",
          state,
          timestamp: now(),
        });
      }
      yield* Effect.withSpan("effect-machine.effect.exit", {
        attributes: { "effect_machine.state": state._tag },
      })(effect.handler({ state, self }));
    }
  });
