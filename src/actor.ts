/**
 * Actor system: spawning, lifecycle, and event processing.
 *
 * Combines:
 * - ActorRef interface (running actor handle)
 * - ActorSystem service (spawn/stop/get actors)
 * - Actor creation and event loop
 */
import {
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableHashMap,
  Option,
  Queue,
  Scope,
  SubscriptionRef,
} from "effect";
import type { Stream } from "effect";

import type { Machine, MachineRef } from "./machine.js";
import type { Inspector } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import { processEventCore, runSpawnEffects, resolveTransition } from "./internal/transition.js";
import type { ProcessEventHooks } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";

// Re-export for external use (cluster, persistence)
export { resolveTransition, runSpawnEffects, processEventCore } from "./internal/transition.js";
export type { ProcessEventHooks, ProcessEventResult } from "./internal/transition.js";
import type { GuardsDef, EffectsDef } from "./slot.js";
import { DuplicateActorError, UnprovidedSlotsError } from "./errors.js";
import { INTERNAL_INIT_EVENT } from "./internal/utils.js";
import type {
  ActorMetadata,
  PersistenceError,
  RestoreResult,
  VersionConflictError,
} from "./persistence/adapter.js";
import {
  PersistenceAdapterTag,
  PersistenceError as PersistenceErrorClass,
} from "./persistence/adapter.js";
import type { PersistentMachine } from "./persistence/persistent-machine.js";
import { isPersistentMachine } from "./persistence/persistent-machine.js";
import type { PersistentActorRef } from "./persistence/persistent-actor.js";
import { createPersistentActor, restorePersistentActor } from "./persistence/persistent-actor.js";

// ============================================================================
// ActorRef Interface
// ============================================================================

/**
 * Reference to a running actor.
 */
export interface ActorRef<State extends { readonly _tag: string }, Event> {
  /**
   * Unique identifier for this actor
   */
  readonly id: string;

  /**
   * Send an event to the actor
   */
  readonly send: (event: Event) => Effect.Effect<void>;

  /**
   * Observable state of the actor
   */
  readonly state: SubscriptionRef.SubscriptionRef<State>;

  /**
   * Stop the actor gracefully
   */
  readonly stop: Effect.Effect<void>;

  /**
   * Get current state snapshot (Effect)
   */
  readonly snapshot: Effect.Effect<State>;

  /**
   * Get current state snapshot (sync)
   */
  readonly snapshotSync: () => State;

  /**
   * Check if current state matches tag (Effect)
   */
  readonly matches: (tag: State["_tag"]) => Effect.Effect<boolean>;

  /**
   * Check if current state matches tag (sync)
   */
  readonly matchesSync: (tag: State["_tag"]) => boolean;

  /**
   * Check if event can be handled in current state (Effect)
   */
  readonly can: (event: Event) => Effect.Effect<boolean>;

  /**
   * Check if event can be handled in current state (sync)
   */
  readonly canSync: (event: Event) => boolean;

  /**
   * Stream of state changes
   */
  readonly changes: Stream.Stream<State>;

  /**
   * Subscribe to state changes (sync callback)
   * Returns unsubscribe function
   */
  readonly subscribe: (fn: (state: State) => void) => () => void;
}

// ============================================================================
// ActorSystem Interface
// ============================================================================

/** Base type for stored actors (internal) */
type AnyState = { readonly _tag: string };

/**
 * Actor system for managing actor lifecycles
 */
export interface ActorSystem {
  /**
   * Spawn a new actor with the given machine.
   *
   * For regular machines, returns ActorRef.
   * For persistent machines (created with Machine.persist), returns PersistentActorRef.
   *
   * Note: All effect slots must be provided via `Machine.provide` before spawning.
   * Attempting to spawn a machine with unprovided effect slots will fail.
   *
   * @example
   * ```ts
   * // Regular machine (effects provided)
   * const machine = Machine.provide(baseMachine, { fetchData: ... })
   * const actor = yield* system.spawn("my-actor", machine);
   *
   * // Persistent machine (auto-detected)
   * const persistentActor = yield* system.spawn("my-actor", persistentMachine);
   * persistentActor.persist; // available
   * persistentActor.version; // available
   * ```
   */
  readonly spawn: {
    // Regular machine overload
    <
      S extends { readonly _tag: string },
      E extends { readonly _tag: string },
      R,
      GD extends GuardsDef = Record<string, never>,
      EFD extends EffectsDef = Record<string, never>,
    >(
      id: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
      machine: Machine<S, E, R, any, any, GD, EFD>,
    ): Effect.Effect<ActorRef<S, E>, DuplicateActorError | UnprovidedSlotsError, R | Scope.Scope>;

    // Persistent machine overload
    <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
      id: string,
      machine: PersistentMachine<S, E, R>,
    ): Effect.Effect<
      PersistentActorRef<S, E, R>,
      PersistenceError | VersionConflictError | DuplicateActorError | UnprovidedSlotsError,
      R | Scope.Scope | PersistenceAdapterTag
    >;
  };

  /**
   * Restore an actor from persistence.
   * Returns None if no persisted state exists for the given ID.
   *
   * @example
   * ```ts
   * const maybeActor = yield* system.restore("order-1", persistentMachine);
   * if (Option.isSome(maybeActor)) {
   *   const actor = maybeActor.value;
   *   const state = yield* actor.snapshot;
   *   console.log(`Restored to state: ${state._tag}`);
   * }
   * ```
   */
  readonly restore: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<
    Option.Option<PersistentActorRef<S, E, R>>,
    PersistenceError | DuplicateActorError | UnprovidedSlotsError,
    R | Scope.Scope | PersistenceAdapterTag
  >;

  /**
   * Get an existing actor by ID
   */
  readonly get: (id: string) => Effect.Effect<Option.Option<ActorRef<AnyState, unknown>>>;

  /**
   * Stop an actor by ID
   */
  readonly stop: (id: string) => Effect.Effect<boolean>;

  /**
   * List all persisted actor metadata.
   * Returns empty array if adapter doesn't support registry.
   *
   * @example
   * ```ts
   * const actors = yield* system.listPersisted();
   * for (const meta of actors) {
   *   console.log(`${meta.id}: ${meta.stateTag} (v${meta.version})`);
   * }
   * ```
   */
  readonly listPersisted: () => Effect.Effect<
    ReadonlyArray<ActorMetadata>,
    PersistenceError,
    PersistenceAdapterTag
  >;

  /**
   * Restore multiple actors by ID.
   * Returns both successfully restored actors and failures.
   *
   * @example
   * ```ts
   * const result = yield* system.restoreMany(["order-1", "order-2"], orderMachine);
   * console.log(`Restored: ${result.restored.length}, Failed: ${result.failed.length}`);
   * ```
   */
  readonly restoreMany: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    ids: ReadonlyArray<string>,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<RestoreResult<S, E, R>, never, R | Scope.Scope | PersistenceAdapterTag>;

  /**
   * Restore all persisted actors for a machine type.
   * Uses adapter registry if available, otherwise returns empty result.
   *
   * @example
   * ```ts
   * const result = yield* system.restoreAll(orderMachine, {
   *   filter: (meta) => meta.stateTag !== "Done"
   * });
   * console.log(`Restored ${result.restored.length} active orders`);
   * ```
   */
  readonly restoreAll: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    machine: PersistentMachine<S, E, R>,
    options?: { filter?: (meta: ActorMetadata) => boolean },
  ) => Effect.Effect<
    RestoreResult<S, E, R>,
    PersistenceError,
    R | Scope.Scope | PersistenceAdapterTag
  >;
}

/**
 * ActorSystem service tag
 */
export const ActorSystem = Context.GenericTag<ActorSystem>("@effect/machine/ActorSystem");

// ============================================================================
// Actor Core Helpers
// ============================================================================

/** Listener set for sync subscriptions */
export type Listeners<S> = Set<(state: S) => void>;

/**
 * Notify all listeners of state change.
 */
export const notifyListeners = <S>(listeners: Listeners<S>, state: S): void => {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // Ignore listener failures to avoid crashing the actor loop
    }
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
): ActorRef<S, E> => {
  const send = Effect.fn("effect-machine.actor.send")(function* (event: E) {
    yield* Queue.offer(eventQueue, event);
  });

  const snapshot = SubscriptionRef.get(stateRef).pipe(
    Effect.withSpan("effect-machine.actor.snapshot"),
  );

  const matches = Effect.fn("effect-machine.actor.matches")(function* (tag: S["_tag"]) {
    const state = yield* SubscriptionRef.get(stateRef);
    return state._tag === tag;
  });

  const can = Effect.fn("effect-machine.actor.can")(function* (event: E) {
    const state = yield* SubscriptionRef.get(stateRef);
    return resolveTransition(machine, state, event) !== undefined;
  });

  return {
    id,
    send,
    state: stateRef,
    stop,
    snapshot,
    snapshotSync: () => Effect.runSync(SubscriptionRef.get(stateRef)),
    matches,
    matchesSync: (tag) => Effect.runSync(SubscriptionRef.get(stateRef))._tag === tag,
    can,
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
  };
};

// ============================================================================
// Actor Creation and Event Loop
// ============================================================================

/**
 * Create and start an actor for a machine
 */
export const createActor = Effect.fn("effect-machine.actor.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(id: string, machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>) {
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);

  const missing = machine._missingSlots();
  if (missing.length > 0) {
    return yield* new UnprovidedSlotsError({ slots: missing });
  }

  // Get optional inspector from context
  const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
    | Inspector<S, E>
    | undefined;

  // Create self reference for sending events
  const eventQueue = yield* Queue.unbounded<E>();
  const self: MachineRef<E> = {
    send: Effect.fn("effect-machine.actor.self.send")(function* (event: E) {
      yield* Queue.offer(eventQueue, event);
    }),
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
  const ctx = { state: machine.initial, event: initEvent, self };
  const { effects: effectSlots } = machine._slots;

  for (const bg of machine.backgroundEffects) {
    const fiber = yield* Effect.fork(
      bg
        .handler({ state: machine.initial, event: initEvent, self, effects: effectSlots })
        .pipe(Effect.provideService(machine.Context, ctx)),
    );
    backgroundFibers.push(fiber);
  }

  // Create state scope for initial state's spawn effects
  const stateScopeRef: { current: Scope.CloseableScope } = {
    current: yield* Scope.make(),
  };

  // Run initial spawn effects
  yield* runSpawnEffectsWithInspection(
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
    const stop = Queue.shutdown(eventQueue).pipe(
      Effect.withSpan("effect-machine.actor.stop"),
      Effect.asVoid,
    );
    return buildActorRefCore(id, machine, stateRef, eventQueue, listeners, stop);
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

  const stop = Effect.gen(function* () {
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
  }).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid);

  return buildActorRefCore(id, machine, stateRef, eventQueue, listeners, stop);
});

/**
 * Main event loop for the actor
 */
const eventLoop = Effect.fn("effect-machine.actor.eventLoop")(function* <
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
) {
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
 * Process a single event, returning true if the actor should stop.
 * Wraps processEventCore with actor-specific concerns (inspection, listeners, state ref).
 */
const processEvent = Effect.fn("effect-machine.actor.processEvent")(function* <
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
) {
  // Emit event received
  yield* emitWithTimestamp(inspector, (timestamp) => ({
    type: "@machine.event",
    actorId,
    state: currentState,
    event,
    timestamp,
  }));

  // Build inspection hooks for processEventCore
  const hooks: ProcessEventHooks<S, E> | undefined =
    inspector === undefined
      ? undefined
      : {
          onSpawnEffect: (state) =>
            emitWithTimestamp(inspector, (timestamp) => ({
              type: "@machine.effect",
              actorId,
              effectType: "spawn",
              state,
              timestamp,
            })),
          onTransition: (from, to, ev) =>
            emitWithTimestamp(inspector, (timestamp) => ({
              type: "@machine.transition",
              actorId,
              fromState: from,
              toState: to,
              event: ev,
              timestamp,
            })),
        };

  // Process event using shared core
  const result = yield* processEventCore(machine, currentState, event, self, stateScopeRef, hooks);

  if (!result.transitioned) {
    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
    return false;
  }

  yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);

  // Update state ref and notify listeners
  yield* SubscriptionRef.set(stateRef, result.newState);
  notifyListeners(listeners, result.newState);

  if (result.lifecycleRan) {
    yield* Effect.annotateCurrentSpan("effect_machine.state.from", result.previousState._tag);
    yield* Effect.annotateCurrentSpan("effect_machine.state.to", result.newState._tag);

    // Transition inspection event emitted via hooks in processEventCore

    // Check if new state is final
    if (result.isFinal) {
      yield* emitWithTimestamp(inspector, (timestamp) => ({
        type: "@machine.stop",
        actorId,
        finalState: result.newState,
        timestamp,
      }));
      return true;
    }
  }

  return false;
});

/**
 * Run spawn effects with actor-specific inspection and tracing.
 * Wraps the core runSpawnEffects with inspection events and spans.
 * @internal
 */
const runSpawnEffectsWithInspection = Effect.fn("effect-machine.actor.spawnEffects")(function* <
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
  actorId: string,
  inspector?: Inspector<S, E>,
) {
  // Emit inspection event before running effects
  yield* emitWithTimestamp(inspector, (timestamp) => ({
    type: "@machine.effect",
    actorId,
    effectType: "spawn",
    state,
    timestamp,
  }));

  // Use shared core
  yield* runSpawnEffects(machine, state, event, self, stateScope);
});

// ============================================================================
// ActorSystem Implementation
// ============================================================================

/**
 * Internal implementation
 */
const make = Effect.sync(() => {
  // MutableHashMap for O(1) spawn/stop/get operations
  const actors = MutableHashMap.empty<string, ActorRef<AnyState, unknown>>();

  /** Check for duplicate ID, register actor, add cleanup finalizer */
  const registerActor = Effect.fn("effect-machine.actorSystem.register")(function* <
    T extends { stop: Effect.Effect<void> },
  >(id: string, actor: T) {
    // Check if actor already exists
    if (MutableHashMap.has(actors, id)) {
      // Stop the newly created actor to avoid leaks
      yield* actor.stop;
      return yield* new DuplicateActorError({ actorId: id });
    }

    // Register it - O(1)
    MutableHashMap.set(actors, id, actor as unknown as ActorRef<AnyState, unknown>);

    // Register cleanup on scope finalization
    yield* Effect.addFinalizer(
      Effect.fn("effect-machine.actorSystem.register.finalizer")(function* () {
        yield* actor.stop;
        MutableHashMap.remove(actors, id);
      }),
    );

    return actor;
  });

  const spawnRegular = Effect.fn("effect-machine.actorSystem.spawnRegular")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(id: string, machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>) {
    if (MutableHashMap.has(actors, id)) {
      return yield* new DuplicateActorError({ actorId: id });
    }
    // Create and register the actor
    const actor = yield* createActor(id, machine);
    return yield* registerActor(id, actor);
  });

  const spawnPersistent = Effect.fn("effect-machine.actorSystem.spawnPersistent")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(id: string, persistentMachine: PersistentMachine<S, E, R>) {
    if (MutableHashMap.has(actors, id)) {
      return yield* new DuplicateActorError({ actorId: id });
    }
    const adapter = yield* PersistenceAdapterTag;

    // Try to load existing snapshot
    const maybeSnapshot = yield* adapter.loadSnapshot(
      id,
      persistentMachine.persistence.stateSchema,
    );

    // Load events after snapshot (or all events if no snapshot)
    const events = yield* adapter.loadEvents(
      id,
      persistentMachine.persistence.eventSchema,
      Option.isSome(maybeSnapshot) ? maybeSnapshot.value.version : undefined,
    );

    // Create and register the persistent actor
    const actor = yield* createPersistentActor(id, persistentMachine, maybeSnapshot, events);
    return yield* registerActor(id, actor);
  });

  const spawnImpl = Effect.fn("effect-machine.actorSystem.spawn")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine:
      | Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>
      | PersistentMachine<S, E, R>,
  ) {
    if (isPersistentMachine(machine)) {
      // TypeScript can't narrow union with invariant generic params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return yield* spawnPersistent(id, machine as PersistentMachine<S, E, R>);
    }
    return yield* spawnRegular(
      id,
      machine as Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
    );
  });

  // Type-safe overloaded spawn implementation
  function spawn<
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  ): Effect.Effect<ActorRef<S, E>, DuplicateActorError | UnprovidedSlotsError, R | Scope.Scope>;
  function spawn<S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: PersistentMachine<S, E, R>,
  ): Effect.Effect<
    PersistentActorRef<S, E, R>,
    PersistenceError | VersionConflictError | DuplicateActorError | UnprovidedSlotsError,
    R | Scope.Scope | PersistenceAdapterTag
  >;
  function spawn<
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine:
      | Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>
      | PersistentMachine<S, E, R>,
  ):
    | Effect.Effect<ActorRef<S, E>, DuplicateActorError | UnprovidedSlotsError, R | Scope.Scope>
    | Effect.Effect<
        PersistentActorRef<S, E, R>,
        PersistenceError | VersionConflictError | DuplicateActorError | UnprovidedSlotsError,
        R | Scope.Scope | PersistenceAdapterTag
      > {
    return spawnImpl(id, machine) as
      | Effect.Effect<ActorRef<S, E>, DuplicateActorError | UnprovidedSlotsError, R | Scope.Scope>
      | Effect.Effect<
          PersistentActorRef<S, E, R>,
          PersistenceError | VersionConflictError | DuplicateActorError | UnprovidedSlotsError,
          R | Scope.Scope | PersistenceAdapterTag
        >;
  }

  const restore = Effect.fn("effect-machine.actorSystem.restore")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(id: string, persistentMachine: PersistentMachine<S, E, R>) {
    // Try to restore from persistence
    const maybeActor = yield* restorePersistentActor(id, persistentMachine);

    if (Option.isSome(maybeActor)) {
      yield* registerActor(id, maybeActor.value);
    }

    return maybeActor;
  });

  const get = Effect.fn("effect-machine.actorSystem.get")(function* (id: string) {
    return yield* Effect.sync(() => MutableHashMap.get(actors, id));
  });

  const stop = Effect.fn("effect-machine.actorSystem.stop")(function* (id: string) {
    const maybeActor = MutableHashMap.get(actors, id);
    if (Option.isNone(maybeActor)) {
      return false;
    }

    yield* maybeActor.value.stop;
    MutableHashMap.remove(actors, id);
    return true;
  });

  const listPersisted = Effect.fn("effect-machine.actorSystem.listPersisted")(function* () {
    const adapter = yield* PersistenceAdapterTag;
    if (adapter.listActors === undefined) {
      return [];
    }
    return yield* adapter.listActors();
  });

  const restoreMany = Effect.fn("effect-machine.actorSystem.restoreMany")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(ids: ReadonlyArray<string>, persistentMachine: PersistentMachine<S, E, R>) {
    const restored: PersistentActorRef<S, E, R>[] = [];
    const failed: {
      id: string;
      error: PersistenceError | DuplicateActorError | UnprovidedSlotsError;
    }[] = [];

    for (const id of ids) {
      // Skip if already running
      if (MutableHashMap.has(actors, id)) {
        continue;
      }

      const result = yield* Effect.either(restore(id, persistentMachine));
      if (result._tag === "Left") {
        failed.push({ id, error: result.left });
      } else if (Option.isSome(result.right)) {
        restored.push(result.right.value);
      } else {
        // No persisted state for this ID
        failed.push({
          id,
          error: new PersistenceErrorClass({
            operation: "restore",
            actorId: id,
            message: "No persisted state found",
          }),
        });
      }
    }

    return { restored, failed };
  });

  const restoreAll = Effect.fn("effect-machine.actorSystem.restoreAll")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    persistentMachine: PersistentMachine<S, E, R>,
    options?: { filter?: (meta: ActorMetadata) => boolean },
  ) {
    const adapter = yield* PersistenceAdapterTag;
    if (adapter.listActors === undefined) {
      return { restored: [], failed: [] };
    }

    // Require explicit machineType to prevent cross-machine restores
    const machineType = persistentMachine.persistence.machineType;
    if (machineType === undefined) {
      return yield* new PersistenceErrorClass({
        operation: "restoreAll",
        actorId: "*",
        message: "restoreAll requires explicit machineType in persistence config",
      });
    }

    const allMetadata = yield* adapter.listActors();

    // Filter by machineType and optional user filter
    let filtered = allMetadata.filter((meta) => meta.machineType === machineType);
    if (options?.filter !== undefined) {
      filtered = filtered.filter(options.filter);
    }

    const ids = filtered.map((meta) => meta.id);
    return yield* restoreMany(ids, persistentMachine);
  });

  return ActorSystem.of({ spawn, restore, get, stop, listPersisted, restoreMany, restoreAll });
}).pipe(Effect.withSpan("effect-machine.actorSystem.make"));

/**
 * Default ActorSystem layer
 */
export const Default = Layer.effect(ActorSystem, make);
