// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics anyUnknownInErrorContext:off

import {
  Clock,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schedule,
  Scope,
  SubscriptionRef,
} from "effect";

import type { ActorRef, Listeners } from "../actor.js";
import { buildActorRefCore, notifyListeners } from "../actor.js";
import type { MachineRef, Machine } from "../machine.js";
import type { Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import {
  processEventCore,
  resolveTransition,
  runSpawnEffects,
  runTransitionHandler,
} from "../internal/transition.js";
import type { GuardsDef, EffectsDef } from "../slot.js";
import { UnprovidedSlotsError } from "../errors.js";
import { INTERNAL_INIT_EVENT } from "../internal/utils.js";
import { emitWithTimestamp } from "../internal/inspection.js";

import type {
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  PersistenceError,
  Snapshot,
  VersionConflictError,
} from "./adapter.js";
import { PersistenceAdapterTag } from "./adapter.js";
import type { PersistentMachine } from "./persistent-machine.js";

/**
 * Extended ActorRef with persistence capabilities
 */
export interface PersistentActorRef<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R = never,
> extends ActorRef<S, E> {
  /**
   * Force an immediate snapshot save
   */
  readonly persist: Effect.Effect<void, PersistenceError | VersionConflictError>;

  /**
   * Get the current persistence version
   */
  readonly version: Effect.Effect<number>;

  /**
   * Replay events to restore actor to a specific version.
   * Note: This only computes state; does not re-run transition effects.
   */
  readonly replayTo: (version: number) => Effect.Effect<void, PersistenceError, R>;
}

/** Get current time in milliseconds using Effect Clock */
const now = Clock.currentTimeMillis;

/**
 * Replay persisted events to compute state.
 * Supports async handlers - used for initial restore.
 * @internal
 */
const replayEvents = Effect.fn("effect-machine.persistentActor.replayEvents")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  startState: S,
  events: ReadonlyArray<PersistedEvent<E>>,
  self: MachineRef<E>,
  stopVersion?: number,
) {
  let state = startState;
  let version = 0;

  for (const persistedEvent of events) {
    if (stopVersion !== undefined && persistedEvent.version > stopVersion) break;

    const transition = resolveTransition(machine, state, persistedEvent.event);
    if (transition !== undefined) {
      state = yield* runTransitionHandler(machine, transition, state, persistedEvent.event, self);
    }
    version = persistedEvent.version;
  }

  return { state, version };
});

/**
 * Build PersistentActorRef with all methods
 */
const buildPersistentActorRef = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  versionRef: Ref.Ref<number>,
  eventQueue: Queue.Queue<E>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
  adapter: PersistenceAdapter,
): PersistentActorRef<S, E, R> => {
  const { machine, persistence } = persistentMachine;
  const typedMachine = machine as unknown as Machine<
    S,
    E,
    R,
    Record<string, never>,
    Record<string, never>,
    GD,
    EFD
  >;

  const persist = Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(stateRef);
    const version = yield* Ref.get(versionRef);
    const timestamp = yield* now;
    const snapshot: Snapshot<S> = {
      state,
      version,
      timestamp,
    };
    yield* adapter.saveSnapshot(id, snapshot, persistence.stateSchema);
  }).pipe(Effect.withSpan("effect-machine.persistentActor.persist"));

  const version = Ref.get(versionRef).pipe(
    Effect.withSpan("effect-machine.persistentActor.version"),
  );

  // Replay only computes state - doesn't run spawn effects
  const replayTo = Effect.fn("effect-machine.persistentActor.replayTo")(function* (
    targetVersion: number,
  ) {
    const currentVersion = yield* Ref.get(versionRef);
    if (targetVersion <= currentVersion) {
      const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);
      if (Option.isSome(maybeSnapshot)) {
        const snapshot = maybeSnapshot.value;
        if (snapshot.version <= targetVersion) {
          const events = yield* adapter.loadEvents(id, persistence.eventSchema, snapshot.version);
          const dummySelf: MachineRef<E> = {
            send: Effect.fn("effect-machine.persistentActor.replay.send")(
              (_event: E) => Effect.void,
            ),
          };

          const result = yield* replayEvents(
            typedMachine,
            snapshot.state,
            events,
            dummySelf,
            targetVersion,
          );

          yield* SubscriptionRef.set(stateRef, result.state);
          yield* Ref.set(versionRef, result.version);
          notifyListeners(listeners, result.state);
        }
      } else {
        // No snapshot - replay from initial state if events exist
        const events = yield* adapter.loadEvents(id, persistence.eventSchema);
        if (events.length > 0) {
          const dummySelf: MachineRef<E> = {
            send: Effect.fn("effect-machine.persistentActor.replay.send")(
              (_event: E) => Effect.void,
            ),
          };
          const result = yield* replayEvents(
            typedMachine,
            typedMachine.initial,
            events,
            dummySelf,
            targetVersion,
          );
          yield* SubscriptionRef.set(stateRef, result.state);
          yield* Ref.set(versionRef, result.version);
          notifyListeners(listeners, result.state);
        }
      }
    }
  });

  const core = buildActorRefCore(id, typedMachine, stateRef, eventQueue, listeners, stop);

  return {
    ...core,
    persist,
    version,
    replayTo,
  };
};

/**
 * Create a persistent actor from a PersistentMachine.
 * Restores from existing snapshot if available, otherwise starts fresh.
 */
export const createPersistentActor = Effect.fn("effect-machine.persistentActor.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  initialSnapshot: Option.Option<Snapshot<S>>,
  initialEvents: ReadonlyArray<PersistedEvent<E>>,
) {
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
  const adapter = yield* PersistenceAdapterTag;
  const { machine, persistence } = persistentMachine;
  const typedMachine = machine as unknown as Machine<
    S,
    E,
    R,
    Record<string, never>,
    Record<string, never>,
    GD,
    EFD
  >;

  const missing = typedMachine._missingSlots();
  if (missing.length > 0) {
    return yield* new UnprovidedSlotsError({ slots: missing });
  }

  // Get optional inspector from context
  const inspector = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
    | Inspector<S, E>
    | undefined;

  // Create self reference for sending events
  const eventQueue = yield* Queue.unbounded<E>();
  const self: MachineRef<E> = {
    send: Effect.fn("effect-machine.persistentActor.self.send")(function* (event: E) {
      yield* Queue.offer(eventQueue, event);
    }),
  };

  // Determine initial state and version
  let resolvedInitial: S;
  let initialVersion: number;

  if (Option.isSome(initialSnapshot)) {
    // Restore from snapshot + replay events
    const result = yield* replayEvents(
      typedMachine,
      initialSnapshot.value.state,
      initialEvents,
      self,
    );
    resolvedInitial = result.state;
    initialVersion = initialEvents.length > 0 ? result.version : initialSnapshot.value.version;
  } else if (initialEvents.length > 0) {
    // Restore from events only
    const result = yield* replayEvents(typedMachine, typedMachine.initial, initialEvents, self);
    resolvedInitial = result.state;
    initialVersion = result.version;
  } else {
    // Fresh start
    resolvedInitial = typedMachine.initial;
    initialVersion = 0;
  }

  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", resolvedInitial._tag);

  // Initialize state refs
  const stateRef = yield* SubscriptionRef.make(resolvedInitial);
  const versionRef = yield* Ref.make(initialVersion);
  const listeners: Listeners<S> = new Set();

  // Track creation time for metadata - prefer existing metadata if restoring
  let createdAt: number;
  if (Option.isSome(initialSnapshot)) {
    // Restoring - try to get original createdAt from metadata
    const existingMeta =
      adapter.loadMetadata !== undefined
        ? yield* adapter.loadMetadata(id)
        : Option.none<ActorMetadata>();
    createdAt = Option.isSome(existingMeta)
      ? existingMeta.value.createdAt
      : initialSnapshot.value.timestamp; // fallback to snapshot time
  } else {
    createdAt = yield* now;
  }

  // Emit spawn event
  yield* emitWithTimestamp(inspector, (timestamp) => ({
    type: "@machine.spawn",
    actorId: id,
    initialState: resolvedInitial,
    timestamp,
  }));

  // Save initial metadata
  yield* saveMetadata(id, resolvedInitial, initialVersion, createdAt, persistence, adapter);

  // Snapshot scheduler
  const snapshotQueue = yield* Queue.unbounded<{ state: S; version: number }>();
  const snapshotFiber = yield* Effect.fork(snapshotWorker(id, persistence, adapter, snapshotQueue));

  // Fork background effects (run for entire machine lifetime)
  const backgroundFibers: Fiber.Fiber<void, never>[] = [];
  const initEvent = { _tag: INTERNAL_INIT_EVENT } as E;
  const initCtx = { state: resolvedInitial, event: initEvent, self };
  const { effects: effectSlots } = typedMachine._slots;

  for (const bg of typedMachine.backgroundEffects) {
    const fiber = yield* Effect.fork(
      bg
        .handler({ state: resolvedInitial, event: initEvent, self, effects: effectSlots })
        .pipe(Effect.provideService(typedMachine.Context, initCtx)),
    );
    backgroundFibers.push(fiber);
  }

  // Create state scope for spawn effects
  const stateScopeRef: { current: Scope.CloseableScope } = {
    current: yield* Scope.make(),
  };

  // Run initial spawn effects
  yield* runSpawnEffectsWithInspection(
    typedMachine,
    resolvedInitial,
    initEvent,
    self,
    stateScopeRef.current,
    id,
    inspector,
  );

  // Check if initial state is final
  if (typedMachine.finalStates.has(resolvedInitial._tag)) {
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* Queue.shutdown(snapshotQueue).pipe(Effect.asVoid);
    yield* Fiber.interrupt(snapshotFiber);
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.stop",
      actorId: id,
      finalState: resolvedInitial,
      timestamp,
    }));
    const stop = Queue.shutdown(eventQueue).pipe(
      Effect.withSpan("effect-machine.persistentActor.stop"),
      Effect.asVoid,
    );
    return buildPersistentActorRef(
      id,
      persistentMachine,
      stateRef,
      versionRef,
      eventQueue,
      listeners,
      stop,
      adapter,
    );
  }

  // Start the persistent event loop
  const loopFiber = yield* Effect.fork(
    persistentEventLoop(
      id,
      persistentMachine,
      stateRef,
      versionRef,
      eventQueue,
      self,
      listeners,
      adapter,
      createdAt,
      stateScopeRef,
      backgroundFibers,
      snapshotQueue,
      snapshotFiber,
      inspector,
    ),
  );

  const stop = Effect.gen(function* () {
    const finalState = yield* SubscriptionRef.get(stateRef);
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.stop",
      actorId: id,
      finalState,
      timestamp,
    }));
    yield* Queue.shutdown(eventQueue);
    yield* Fiber.interrupt(loopFiber);
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* Queue.shutdown(snapshotQueue).pipe(Effect.asVoid);
    yield* Fiber.interrupt(snapshotFiber);
  }).pipe(Effect.withSpan("effect-machine.persistentActor.stop"), Effect.asVoid);

  return buildPersistentActorRef(
    id,
    persistentMachine,
    stateRef,
    versionRef,
    eventQueue,
    listeners,
    stop,
    adapter,
  );
});

/**
 * Main event loop for persistent actor
 */
const persistentEventLoop = Effect.fn("effect-machine.persistentActor.eventLoop")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  versionRef: Ref.Ref<number>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  adapter: PersistenceAdapter,
  createdAt: number,
  stateScopeRef: { current: Scope.CloseableScope },
  backgroundFibers: ReadonlyArray<Fiber.Fiber<void, never>>,
  snapshotQueue: Queue.Queue<{ state: S; version: number }>,
  snapshotFiber: Fiber.Fiber<void, never>,
  inspector?: Inspector<S, E>,
) {
  const { machine, persistence } = persistentMachine;
  const typedMachine = machine as unknown as Machine<
    S,
    E,
    R,
    Record<string, never>,
    Record<string, never>,
    GD,
    EFD
  >;

  const hooks =
    inspector === undefined
      ? undefined
      : {
          onSpawnEffect: (state: S) =>
            emitWithTimestamp(inspector, (timestamp) => ({
              type: "@machine.effect",
              actorId: id,
              effectType: "spawn",
              state,
              timestamp,
            })),
          onTransition: (from: S, to: S, ev: E) =>
            emitWithTimestamp(inspector, (timestamp) => ({
              type: "@machine.transition",
              actorId: id,
              fromState: from,
              toState: to,
              event: ev,
              timestamp,
            })),
        };

  while (true) {
    const event = yield* Queue.take(eventQueue);
    const currentState = yield* SubscriptionRef.get(stateRef);
    const currentVersion = yield* Ref.get(versionRef);

    // Emit event received
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.event",
      actorId: id,
      state: currentState,
      event,
      timestamp,
    }));

    const result = yield* processEventCore(
      typedMachine,
      currentState,
      event,
      self,
      stateScopeRef,
      hooks,
    );

    if (!result.transitioned) {
      continue;
    }

    // Increment version
    const newVersion = currentVersion + 1;
    yield* Ref.set(versionRef, newVersion);

    // Journal event if enabled
    if (persistence.journalEvents) {
      const timestamp = yield* now;
      const persistedEvent: PersistedEvent<E> = {
        event,
        version: newVersion,
        timestamp,
      };
      yield* adapter
        .appendEvent(id, persistedEvent, persistence.eventSchema)
        .pipe(
          Effect.catchAll((e) => Effect.logWarning(`Failed to journal event for actor ${id}`, e)),
        );
    }

    // Update state and notify listeners
    yield* SubscriptionRef.set(stateRef, result.newState);
    notifyListeners(listeners, result.newState);

    // Save metadata
    yield* saveMetadata(id, result.newState, newVersion, createdAt, persistence, adapter);

    // Schedule snapshot (non-blocking)
    yield* Queue.offer(snapshotQueue, { state: result.newState, version: newVersion });

    // Check if final state reached
    if (result.lifecycleRan && result.isFinal) {
      yield* emitWithTimestamp(inspector, (timestamp) => ({
        type: "@machine.stop",
        actorId: id,
        finalState: result.newState,
        timestamp,
      }));
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
      yield* Queue.shutdown(snapshotQueue).pipe(Effect.asVoid);
      yield* Fiber.interrupt(snapshotFiber);
      return;
    }
  }
});

/**
 * Run spawn effects with inspection and tracing.
 * @internal
 */
const runSpawnEffectsWithInspection = Effect.fn("effect-machine.persistentActor.spawnEffects")(
  function* <
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
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.effect",
      actorId,
      effectType: "spawn",
      state,
      timestamp,
    }));

    yield* runSpawnEffects(machine, state, event, self, stateScope);
  },
);

/**
 * Snapshot scheduler worker (runs in background).
 */
const snapshotWorker = Effect.fn("effect-machine.persistentActor.snapshotWorker")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  id: string,
  persistence: PersistentMachine<S, E, never>["persistence"],
  adapter: PersistenceAdapter,
  queue: Queue.Queue<{ state: S; version: number }>,
) {
  const driver = yield* Schedule.driver(persistence.snapshotSchedule);

  while (true) {
    const { state, version } = yield* Queue.take(queue);
    const shouldSnapshot = yield* driver.next(state).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      }),
    );
    if (!shouldSnapshot) {
      yield* Queue.shutdown(queue).pipe(Effect.asVoid);
      return;
    }

    yield* saveSnapshot(id, state, version, persistence, adapter);
  }
});

/**
 * Save a snapshot after state transition.
 * Called by snapshot scheduler.
 */
const saveSnapshot = Effect.fn("effect-machine.persistentActor.saveSnapshot")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  id: string,
  state: S,
  version: number,
  persistence: PersistentMachine<S, E, never>["persistence"],
  adapter: PersistenceAdapter,
) {
  const timestamp = yield* now;
  const snapshot: Snapshot<S> = {
    state,
    version,
    timestamp,
  };
  yield* adapter
    .saveSnapshot(id, snapshot, persistence.stateSchema)
    .pipe(Effect.catchAll((e) => Effect.logWarning(`Failed to save snapshot for actor ${id}`, e)));
});

/**
 * Save or update actor metadata if adapter supports registry.
 * Called on spawn and state transitions.
 */
const saveMetadata = Effect.fn("effect-machine.persistentActor.saveMetadata")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  id: string,
  state: S,
  version: number,
  createdAt: number,
  persistence: PersistentMachine<S, E, never>["persistence"],
  adapter: PersistenceAdapter,
) {
  const save = adapter.saveMetadata;
  if (save === undefined) {
    return;
  }
  const lastActivityAt = yield* now;
  const metadata: ActorMetadata = {
    id,
    machineType: persistence.machineType ?? "unknown",
    createdAt,
    lastActivityAt,
    version,
    stateTag: state._tag,
  };
  yield* save(metadata).pipe(
    Effect.catchAll((e) => Effect.logWarning(`Failed to save metadata for actor ${id}`, e)),
  );
});

/**
 * Restore an actor from persistence.
 * Returns None if no persisted state exists.
 */
export const restorePersistentActor = Effect.fn("effect-machine.persistentActor.restore")(
  function* <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    persistentMachine: PersistentMachine<S, E, R>,
  ) {
    const adapter = yield* PersistenceAdapterTag;
    const { persistence } = persistentMachine;

    // Try to load snapshot
    const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);

    // Load events (after snapshot if present)
    const events = yield* adapter.loadEvents(
      id,
      persistence.eventSchema,
      Option.isSome(maybeSnapshot) ? maybeSnapshot.value.version : undefined,
    );

    if (Option.isNone(maybeSnapshot) && events.length === 0) {
      return Option.none();
    }

    // Create actor with restored state
    const actor = yield* createPersistentActor(id, persistentMachine, maybeSnapshot, events);

    return Option.some(actor);
  },
);
