import { Clock, Effect, Exit, Fiber, Option, Queue, Scope, SubscriptionRef } from "effect";

import type { ActorRef } from "../actor-ref.js";
import type { Machine, MachineRef } from "../machine.js";
import type { InspectionEvent, Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import { findTransitions, findSpawnEffects } from "./transition-index.js";
import type { GuardsDef, EffectsDef } from "../slot.js";
import { executeTransition } from "./execute-transition.js";
import { INTERNAL_INIT_EVENT, INTERNAL_ENTER_EVENT } from "./utils.js";
import {
  type Listeners,
  createMachineContext,
  notifyListeners,
  buildActorRefCore,
} from "./actor-core.js";

// ============================================================================
// Inspection Helpers
// ============================================================================

/** Emit an inspection event with timestamp from Clock */
const emitWithTimestamp = <S, E>(
  inspector: Inspector<S, E> | undefined,
  makeEvent: (timestamp: number) => InspectionEvent<S, E>,
): Effect.Effect<void> =>
  inspector === undefined
    ? Effect.void
    : Effect.flatMap(Clock.currentTimeMillis, (timestamp) =>
        Effect.sync(() => inspector.onInspect(makeEvent(timestamp))),
      );

/**
 * Resolve which transition should fire for a given state and event.
 * Uses indexed O(1) lookup. First matching transition wins.
 */
export const resolveTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
): (typeof machine.transitions)[number] | undefined => {
  const candidates = findTransitions(machine, currentState._tag, event._tag);
  return candidates[0];
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
      yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
        type: "@machine.spawn",
        actorId: id,
        initialState: machine.initial,
        timestamp,
      }));

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
        yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
          type: "@machine.stop",
          actorId: id,
          finalState: machine.initial,
          timestamp,
        }));
        return buildActorRefCore(
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

      return buildActorRefCore(
        id,
        machine,
        stateRef,
        eventQueue,
        listeners,
        Effect.gen(function* () {
          const finalState = yield* SubscriptionRef.get(stateRef);
          yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
            type: "@machine.stop",
            actorId: id,
            finalState,
            timestamp,
          }));
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
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.event",
      actorId,
      state: currentState,
      event,
      timestamp,
    }));

    // Execute transition using shared helper
    const result = yield* executeTransition(machine, currentState, event, self);

    if (!result.transitioned) {
      // No transition for this state/event pair - ignore
      yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
      return false;
    }

    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);

    const newState = result.newState;

    // Determine if we should run lifecycle effects
    const stateTagChanged = newState._tag !== currentState._tag;
    // Run lifecycle if:
    // - State tag changed (always run entry/spawn)
    // - reenter=true (force lifecycle even for same tag)
    const runLifecycle = stateTagChanged || result.reenter;

    if (runLifecycle) {
      // Close old state scope (interrupts spawn fibers via forkScoped)
      yield* Scope.close(stateScopeRef.current, Exit.void);

      yield* Effect.annotateCurrentSpan("effect_machine.state.from", currentState._tag);
      yield* Effect.annotateCurrentSpan("effect_machine.state.to", newState._tag);
      yield* Effect.annotateCurrentSpan("effect_machine.transition.reenter", result.reenter);

      // Emit transition event
      yield* emitWithTimestamp(inspector, (timestamp) => ({
        type: "@machine.transition",
        actorId,
        fromState: currentState,
        toState: newState,
        event,
        timestamp,
      }));

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
        yield* emitWithTimestamp(inspector, (timestamp) => ({
          type: "@machine.stop",
          actorId,
          finalState: newState,
          timestamp,
        }));
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
 * @internal
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
    const ctx = createMachineContext(state, event, self);
    const { effects: effectSlots } = machine._createSlotAccessors(ctx);

    for (const spawnEffect of spawnEffects) {
      if (actorId !== undefined) {
        yield* emitWithTimestamp(inspector, (timestamp) => ({
          type: "@machine.effect",
          actorId,
          effectType: "spawn",
          state,
          timestamp,
        }));
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
