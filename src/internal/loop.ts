import { Effect, Exit, Fiber, Option, Queue, Scope, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef, HandlerContext } from "../machine.js";
import type { InspectionEvent, Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import { findTransitions, findSpawnEffects } from "./transition-index.js";
import { isEffect } from "./is-effect.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { INTERNAL_INIT_EVENT, INTERNAL_ENTER_EVENT } from "./constants.js";

/** Listener set for sync subscriptions */
type Listeners<S> = Set<(state: S) => void>;

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
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
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
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
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
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
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

      // Annotate span with initial state
      yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", machine.initial._tag);

      // Emit spawn event
      if (inspectorValue !== undefined) {
        emit(inspectorValue, {
          type: "@machine.spawn",
          actorId: id,
          initialState: machine.initial,
          timestamp: now(),
        });
      }

      // Initialize state
      const stateRef = yield* SubscriptionRef.make(machine.initial);
      const listeners: Listeners<S> = new Set();

      // Fork background effects (run for entire machine lifetime)
      const backgroundFibers: Fiber.Fiber<void, never>[] = [];
      const initEvent = { _tag: INTERNAL_INIT_EVENT } as E;
      const { effects: effectSlots } = machine._createSlotAccessors({
        state: machine.initial,
        event: initEvent,
        self,
      });

      for (const bg of machine.backgroundEffects) {
        const fiber = yield* Effect.fork(
          bg.handler({ state: machine.initial, event: initEvent, self, effects: effectSlots }),
        );
        backgroundFibers.push(fiber);
      }

      // Create state scope for initial state's spawn effects
      const stateScopeRef: { current: Scope.CloseableScope } = {
        current: yield* Scope.make(),
      };

      // Run initial spawn effects
      yield* runSpawnEffects(
        machine,
        machine.initial,
        initEvent,
        self,
        stateScopeRef.current,
        id,
        inspectorValue,
      );

      // Check if initial state (after always) is final
      if (machine.finalStates.has(machine.initial._tag)) {
        // Close state scope and interrupt background effects
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        if (inspectorValue !== undefined) {
          emit(inspectorValue, {
            type: "@machine.stop",
            actorId: id,
            finalState: machine.initial,
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
        eventLoop(
          machine,
          stateRef,
          eventQueue,
          self,
          listeners,
          backgroundFibers,
          stateScopeRef,
          id,
          inspectorValue,
        ),
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
          // Close state scope (interrupts spawn fibers)
          yield* Scope.close(stateScopeRef.current, Exit.void);
          // Interrupt background effects (in parallel)
          yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
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
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  backgroundFibers: Fiber.Fiber<void, never>[],
  stateScopeRef: { current: Scope.CloseableScope },
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
      })(
        processEvent(
          machine,
          currentState,
          event,
          stateRef,
          self,
          listeners,
          stateScopeRef,
          actorId,
          inspector,
        ),
      );

      if (shouldStop) {
        // Close state scope and interrupt background effects when reaching final state
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
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
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  stateScopeRef: { current: Scope.CloseableScope },
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

    // Determine if we should run lifecycle effects
    const stateTagChanged = newState._tag !== currentState._tag;
    // Run lifecycle if:
    // - State tag changed (always run entry/spawn)
    // - reenter=true (force lifecycle even for same tag)
    const runLifecycle = stateTagChanged || transition.reenter === true;

    if (runLifecycle) {
      // Close old state scope (interrupts spawn fibers via forkScoped)
      yield* Scope.close(stateScopeRef.current, Exit.void);

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

      // Create new state scope for entry/spawn effects
      stateScopeRef.current = yield* Scope.make();

      // Use $enter event for lifecycle effects
      const enterEvent = { _tag: INTERNAL_ENTER_EVENT } as E;

      // Run spawn effects for new state (forked into state scope)
      yield* runSpawnEffects(
        machine,
        newState,
        enterEvent,
        self,
        stateScopeRef.current,
        actorId,
        inspector,
      );

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
 * Run spawn effects for a state (forked into state scope, auto-cancelled on state exit)
 */
export const runSpawnEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  event: E,
  self: MachineRef<E>,
  stateScope: Scope.CloseableScope,
  actorId?: string,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const spawnEffects = findSpawnEffects(machine, state._tag);

    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state,
      event,
      self,
    };
    const { effects: effectSlots } = machine._createSlotAccessors(ctx);

    for (const spawnEffect of spawnEffects) {
      if (actorId !== undefined && inspector !== undefined) {
        emit(inspector, {
          type: "@machine.effect",
          actorId,
          effectType: "spawn",
          state,
          timestamp: now(),
        });
      }
      // Fork the spawn effect into the state scope - it will be interrupted when scope closes
      yield* Effect.forkScoped(
        Effect.withSpan("effect-machine.effect.spawn", {
          attributes: { "effect_machine.state": state._tag },
        })(
          (
            spawnEffect.handler({ state, event, self, effects: effectSlots }) as Effect.Effect<
              void,
              never,
              R
            >
          ).pipe(Effect.provideService(machine.Context, ctx)),
        ),
      ).pipe(Effect.provideService(Scope.Scope, stateScope));
    }
  });
