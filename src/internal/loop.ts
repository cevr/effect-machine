import { Effect, Fiber, Option, Queue, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef, HandlerContext } from "../machine.js";
import type { InspectionEvent, Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import {
  findTransitions,
  findAlwaysTransitions,
  findOnEnterEffects,
  findOnExitEffects,
} from "./transition-index.js";
import { isEffect } from "./is-effect.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { DUMMY_ENTER_EVENT, DUMMY_EXIT_EVENT, DUMMY_ALWAYS_EVENT } from "./constants.js";

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
 *
 * Returns Effect because handler may return Effect<State>.
 */
export const resolveTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  _actorId?: string,
  _inspector?: Inspector<S, E>,
): Effect.Effect<(typeof machine.transitions)[number] | undefined, never, R> =>
  Effect.sync(() => {
    const candidates = findTransitions(machine, currentState._tag, event._tag);

    // With the new API, there are no guards on transitions - logic is in handler body
    // So first matching transition wins
    for (const transition of candidates) {
      return transition;
    }
    return undefined;
  });

/**
 * Resolve which always transition should fire for the current state.
 * Uses indexed O(1) lookup.
 */
export const resolveAlwaysTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
): (typeof machine.alwaysTransitions)[number] | undefined => {
  const candidates = findAlwaysTransitions(machine, currentState._tag);

  // First transition wins - guard logic is now in handler body
  for (const transition of candidates) {
    return transition;
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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  self?: MachineRef<E>,
): Effect.Effect<S, never, R> =>
  Effect.gen(function* () {
    let currentState = state;
    let steps = 0;

    // Create slot accessors for always handlers
    const dummySelf: MachineRef<E> = self ?? {
      send: () => Effect.void,
    };
    const dummyEvent = { _tag: DUMMY_ALWAYS_EVENT } as E;
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state: currentState,
      event: dummyEvent,
      self: dummySelf,
    };
    const { guards, effects } = machine._createSlotAccessors(ctx);

    while (steps < MAX_ALWAYS_STEPS) {
      const transition = resolveAlwaysTransition(machine, currentState);
      if (transition === undefined) {
        break;
      }

      const newStateResult = transition.handler(currentState, guards, effects);
      const newState = isEffect(newStateResult) ? yield* newStateResult : newStateResult;

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
const buildActorRef = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
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
    Effect.gen(function* () {
      const s = yield* SubscriptionRef.get(stateRef);
      const transition = yield* resolveTransition(machine, s, event) as Effect.Effect<
        (typeof machine.transitions)[number] | undefined,
        never,
        never
      >;
      return transition !== undefined;
    }),
  canSync: (event) => {
    const state = Effect.runSync(SubscriptionRef.get(stateRef));
    const transition = Effect.runSync(
      resolveTransition(machine, state, event) as Effect.Effect<
        (typeof machine.transitions)[number] | undefined,
        never,
        never
      >,
    );
    return transition !== undefined;
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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
): Effect.Effect<ActorRef<S, E>, never, R> =>
  Effect.withSpan("effect-machine.actor.spawn", {
    attributes: { "effect_machine.actor.id": id },
  })(
    Effect.gen(function* () {
      // Get optional inspector from context
      const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
        | Inspector<S, E>
        | undefined;

      // Create self reference for sending events
      const eventQueue = yield* Queue.unbounded<E>();
      const self: MachineRef<E> = {
        send: (event) => Queue.offer(eventQueue, event),
      };

      // Apply always transitions to initial state
      const resolvedInitial = yield* applyAlways(machine, machine.initial, self);

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
      const listeners: Listeners<S> = new Set();

      // Fork root-level invokes (run for entire machine lifetime)
      const rootFibers: Fiber.Fiber<void, never>[] = [];
      for (const rootInvoke of machine.rootInvokes) {
        const fiber = yield* Effect.fork(rootInvoke.handler({ state: resolvedInitial, self }));
        rootFibers.push(fiber);
      }

      // Run initial entry effects
      yield* runEntryEffects(machine, resolvedInitial, self, id, inspectorValue);

      // Check if initial state (after always) is final
      if (machine.finalStates.has(resolvedInitial._tag)) {
        // Interrupt root invokes on early stop (in parallel)
        yield* Effect.all(rootFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
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

      // Start the event loop (passes rootFibers so they can be interrupted on final state)
      const loopFiber = yield* Effect.fork(
        eventLoop(machine, stateRef, eventQueue, self, listeners, rootFibers, id, inspectorValue),
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
          // Interrupt root-level invokes (in parallel)
          yield* Effect.all(rootFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        }).pipe(Effect.asVoid),
      );
    }),
  );

/**
 * Main event loop for the actor
 */
const eventLoop = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  rootFibers: Fiber.Fiber<void, never>[],
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
        // Interrupt root-level invokes when reaching final state (in parallel)
        yield* Effect.all(rootFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        return;
      }
    }
  });

/**
 * Process a single event, returning true if the actor should stop
 */
const processEvent = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
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

    // Find matching transition
    const transition = yield* resolveTransition(machine, currentState, event, actorId, inspector);

    if (transition === undefined) {
      // No transition for this state/event pair - ignore
      yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
      return false;
    }

    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);

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
    let newState = isEffect(newStateResult)
      ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
          Effect.provideService(machine.Context, ctx),
        )
      : newStateResult;

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
        newState = yield* applyAlways(machine, newState, self);
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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  self: MachineRef<E>,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = findOnEnterEffects(machine, state._tag);

    // Create context for effect slots
    const dummyEvent = { _tag: DUMMY_ENTER_EVENT } as E;
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state,
      event: dummyEvent,
      self,
    };
    const { effects: effectSlots } = machine._createSlotAccessors(ctx);

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
      })(
        (
          effect.handler({ state, self, effects: effectSlots }) as Effect.Effect<void, never, R>
        ).pipe(Effect.provideService(machine.Context, ctx)),
      );
    }
  });

/**
 * Run exit effects for a state
 */
export const runExitEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  self: MachineRef<E>,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const effects = findOnExitEffects(machine, state._tag);

    // Create context for effect slots
    const dummyEvent = { _tag: DUMMY_EXIT_EVENT } as E;
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state,
      event: dummyEvent,
      self,
    };
    const { effects: effectSlots } = machine._createSlotAccessors(ctx);

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
      })(
        (
          effect.handler({ state, self, effects: effectSlots }) as Effect.Effect<void, never, R>
        ).pipe(Effect.provideService(machine.Context, ctx)),
      );
    }
  });
