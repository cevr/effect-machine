import { Inspector } from "../inspection.js";
import { INTERNAL_INIT_EVENT, stubSystem } from "../internal/utils.js";
import {
  processEventCore,
  resolveTransition,
  runSpawnEffects,
  runTransitionHandler,
} from "../internal/transition.js";
import { emitWithTimestamp } from "../internal/inspection.js";
import { PersistenceAdapterTag } from "./adapter.js";
import { ActorSystem, buildActorRefCore, notifyListeners } from "../actor.js";
import {
  Cause,
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
//#region src-v3/persistence/persistent-actor.ts
/** Get current time in milliseconds using Effect Clock */
const now = Clock.currentTimeMillis;
/**
 * Replay persisted events to compute state.
 * Supports async handlers - used for initial restore.
 * @internal
 */
const replayEvents = Effect.fn("effect-machine.persistentActor.replayEvents")(
  function* (machine, startState, events, self, stopVersion) {
    let state = startState;
    let version = 0;
    for (const persistedEvent of events) {
      if (stopVersion !== void 0 && persistedEvent.version > stopVersion) break;
      const transition = resolveTransition(machine, state, persistedEvent.event);
      if (transition !== void 0)
        state = yield* runTransitionHandler(
          machine,
          transition,
          state,
          persistedEvent.event,
          self,
          stubSystem,
        );
      version = persistedEvent.version;
    }
    return {
      state,
      version,
    };
  },
);
/**
 * Build PersistentActorRef with all methods
 */
const buildPersistentActorRef = (
  id,
  persistentMachine,
  stateRef,
  versionRef,
  eventQueue,
  stoppedRef,
  listeners,
  stop,
  adapter,
  system,
  childrenMap,
) => {
  const { machine, persistence } = persistentMachine;
  const typedMachine = machine;
  const persist = Effect.gen(function* () {
    const snapshot = {
      state: yield* SubscriptionRef.get(stateRef),
      version: yield* Ref.get(versionRef),
      timestamp: yield* now,
    };
    yield* adapter.saveSnapshot(id, snapshot, persistence.stateSchema);
  }).pipe(Effect.withSpan("effect-machine.persistentActor.persist"));
  const version = Ref.get(versionRef).pipe(
    Effect.withSpan("effect-machine.persistentActor.version"),
  );
  const replayTo = Effect.fn("effect-machine.persistentActor.replayTo")(function* (targetVersion) {
    if (targetVersion <= (yield* Ref.get(versionRef))) {
      const dummySelf = {
        send: Effect.fn("effect-machine.persistentActor.replay.send")((_event) => Effect.void),
        spawn: () => Effect.die("spawn not supported in replay"),
      };
      const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);
      if (Option.isSome(maybeSnapshot)) {
        const snapshot = maybeSnapshot.value;
        if (snapshot.version <= targetVersion) {
          const events = yield* adapter.loadEvents(id, persistence.eventSchema, snapshot.version);
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
        const events = yield* adapter.loadEvents(id, persistence.eventSchema);
        if (events.length > 0) {
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
  return {
    ...buildActorRefCore(
      id,
      typedMachine,
      stateRef,
      eventQueue,
      stoppedRef,
      listeners,
      stop,
      system,
      childrenMap,
    ),
    persist,
    version,
    replayTo,
  };
};
/**
 * Create a persistent actor from a PersistentMachine.
 * Restores from existing snapshot if available, otherwise starts fresh.
 */
const createPersistentActor = Effect.fn("effect-machine.persistentActor.spawn")(
  function* (id, persistentMachine, initialSnapshot, initialEvents) {
    yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
    const adapter = yield* PersistenceAdapterTag;
    const { machine, persistence } = persistentMachine;
    const typedMachine = machine;
    const existingSystem = yield* Effect.serviceOption(ActorSystem);
    if (Option.isNone(existingSystem))
      return yield* Effect.die("PersistentActor requires ActorSystem in context");
    const system = existingSystem.value;
    const inspector = Option.getOrUndefined(yield* Effect.serviceOption(Inspector));
    const eventQueue = yield* Queue.unbounded();
    const stoppedRef = yield* Ref.make(false);
    const childrenMap = /* @__PURE__ */ new Map();
    const self = {
      send: Effect.fn("effect-machine.persistentActor.self.send")(function* (event) {
        if (yield* Ref.get(stoppedRef)) return;
        yield* Queue.offer(eventQueue, event);
      }),
      spawn: (childId, childMachine) =>
        Effect.gen(function* () {
          const child = yield* system
            .spawn(childId, childMachine)
            .pipe(Effect.provideService(ActorSystem, system));
          childrenMap.set(childId, child);
          const maybeScope = yield* Effect.serviceOption(Scope.Scope);
          if (Option.isSome(maybeScope))
            yield* Scope.addFinalizer(
              maybeScope.value,
              Effect.sync(() => {
                childrenMap.delete(childId);
              }),
            );
          return child;
        }),
    };
    let resolvedInitial;
    let initialVersion;
    if (Option.isSome(initialSnapshot)) {
      const result = yield* replayEvents(
        typedMachine,
        initialSnapshot.value.state,
        initialEvents,
        self,
      );
      resolvedInitial = result.state;
      initialVersion = initialEvents.length > 0 ? result.version : initialSnapshot.value.version;
    } else if (initialEvents.length > 0) {
      const result = yield* replayEvents(typedMachine, typedMachine.initial, initialEvents, self);
      resolvedInitial = result.state;
      initialVersion = result.version;
    } else {
      resolvedInitial = typedMachine.initial;
      initialVersion = 0;
    }
    yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", resolvedInitial._tag);
    const stateRef = yield* SubscriptionRef.make(resolvedInitial);
    const versionRef = yield* Ref.make(initialVersion);
    const listeners = /* @__PURE__ */ new Set();
    let createdAt;
    if (Option.isSome(initialSnapshot)) {
      const existingMeta =
        adapter.loadMetadata !== void 0 ? yield* adapter.loadMetadata(id) : Option.none();
      createdAt = Option.isSome(existingMeta)
        ? existingMeta.value.createdAt
        : initialSnapshot.value.timestamp;
    } else createdAt = yield* now;
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.spawn",
      actorId: id,
      initialState: resolvedInitial,
      timestamp,
    }));
    const snapshotEnabledRef = yield* Ref.make(true);
    const persistenceQueue = yield* Queue.unbounded();
    const persistenceFiber = yield* Effect.forkDaemon(persistenceWorker(persistenceQueue));
    yield* Queue.offer(
      persistenceQueue,
      saveMetadata(id, resolvedInitial, initialVersion, createdAt, persistence, adapter),
    );
    const snapshotQueue = yield* Queue.unbounded();
    const snapshotFiber = yield* Effect.forkDaemon(
      snapshotWorker(id, persistence, adapter, snapshotQueue, snapshotEnabledRef),
    );
    const backgroundFibers = [];
    const initEvent = { _tag: INTERNAL_INIT_EVENT };
    const initCtx = {
      state: resolvedInitial,
      event: initEvent,
      self,
      system,
    };
    const { effects: effectSlots } = typedMachine._slots;
    for (const bg of typedMachine.backgroundEffects) {
      const fiber = yield* Effect.forkDaemon(
        bg
          .handler({
            state: resolvedInitial,
            event: initEvent,
            self,
            effects: effectSlots,
            system,
          })
          .pipe(Effect.provideService(typedMachine.Context, initCtx)),
      );
      backgroundFibers.push(fiber);
    }
    const stateScopeRef = { current: yield* Scope.make() };
    yield* runSpawnEffectsWithInspection(
      typedMachine,
      resolvedInitial,
      initEvent,
      self,
      stateScopeRef.current,
      id,
      inspector,
      system,
    );
    if (typedMachine.finalStates.has(resolvedInitial._tag)) {
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
      yield* Fiber.interrupt(snapshotFiber);
      yield* Fiber.interrupt(persistenceFiber);
      yield* Ref.set(stoppedRef, true);
      yield* emitWithTimestamp(inspector, (timestamp) => ({
        type: "@machine.stop",
        actorId: id,
        finalState: resolvedInitial,
        timestamp,
      }));
      return buildPersistentActorRef(
        id,
        persistentMachine,
        stateRef,
        versionRef,
        eventQueue,
        stoppedRef,
        listeners,
        Ref.set(stoppedRef, true).pipe(
          Effect.withSpan("effect-machine.persistentActor.stop"),
          Effect.asVoid,
        ),
        adapter,
        system,
        childrenMap,
      );
    }
    const loopFiber = yield* Effect.forkDaemon(
      persistentEventLoop(
        id,
        persistentMachine,
        stateRef,
        versionRef,
        eventQueue,
        stoppedRef,
        self,
        listeners,
        adapter,
        createdAt,
        stateScopeRef,
        backgroundFibers,
        snapshotQueue,
        snapshotEnabledRef,
        persistenceQueue,
        snapshotFiber,
        persistenceFiber,
        inspector,
        system,
      ),
    );
    return buildPersistentActorRef(
      id,
      persistentMachine,
      stateRef,
      versionRef,
      eventQueue,
      stoppedRef,
      listeners,
      Effect.gen(function* () {
        const finalState = yield* SubscriptionRef.get(stateRef);
        yield* emitWithTimestamp(inspector, (timestamp) => ({
          type: "@machine.stop",
          actorId: id,
          finalState,
          timestamp,
        }));
        yield* Ref.set(stoppedRef, true);
        yield* Fiber.interrupt(loopFiber);
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        yield* Fiber.interrupt(snapshotFiber);
        yield* Fiber.interrupt(persistenceFiber);
      }).pipe(Effect.withSpan("effect-machine.persistentActor.stop"), Effect.asVoid),
      adapter,
      system,
      childrenMap,
    );
  },
);
/**
 * Main event loop for persistent actor
 */
const persistentEventLoop = Effect.fn("effect-machine.persistentActor.eventLoop")(
  function* (
    id,
    persistentMachine,
    stateRef,
    versionRef,
    eventQueue,
    stoppedRef,
    self,
    listeners,
    adapter,
    createdAt,
    stateScopeRef,
    backgroundFibers,
    snapshotQueue,
    snapshotEnabledRef,
    persistenceQueue,
    snapshotFiber,
    persistenceFiber,
    inspector,
    system,
  ) {
    const { machine, persistence } = persistentMachine;
    const typedMachine = machine;
    const hooks =
      inspector === void 0
        ? void 0
        : {
            onSpawnEffect: (state) =>
              emitWithTimestamp(inspector, (timestamp) => ({
                type: "@machine.effect",
                actorId: id,
                effectType: "spawn",
                state,
                timestamp,
              })),
            onTransition: (from, to, ev) =>
              emitWithTimestamp(inspector, (timestamp) => ({
                type: "@machine.transition",
                actorId: id,
                fromState: from,
                toState: to,
                event: ev,
                timestamp,
              })),
            onError: (info) =>
              emitWithTimestamp(inspector, (timestamp) => ({
                type: "@machine.error",
                actorId: id,
                phase: info.phase,
                state: info.state,
                event: info.event,
                error: Cause.pretty(info.cause),
                timestamp,
              })),
          };
    while (true) {
      const event = yield* Queue.take(eventQueue);
      const currentState = yield* SubscriptionRef.get(stateRef);
      const currentVersion = yield* Ref.get(versionRef);
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
        system,
        hooks,
      );
      if (!result.transitioned) continue;
      const newVersion = currentVersion + 1;
      yield* Ref.set(versionRef, newVersion);
      yield* SubscriptionRef.set(stateRef, result.newState);
      notifyListeners(listeners, result.newState);
      if (persistence.journalEvents) {
        const persistedEvent = {
          event,
          version: newVersion,
          timestamp: yield* now,
        };
        const journalTask = adapter.appendEvent(id, persistedEvent, persistence.eventSchema).pipe(
          Effect.catchAll((e) => Effect.logWarning(`Failed to journal event for actor ${id}`, e)),
          Effect.asVoid,
        );
        yield* Queue.offer(persistenceQueue, journalTask);
      }
      yield* Queue.offer(
        persistenceQueue,
        saveMetadata(id, result.newState, newVersion, createdAt, persistence, adapter),
      );
      if (yield* Ref.get(snapshotEnabledRef))
        yield* Queue.offer(snapshotQueue, {
          state: result.newState,
          version: newVersion,
        });
      if (result.lifecycleRan && result.isFinal) {
        yield* emitWithTimestamp(inspector, (timestamp) => ({
          type: "@machine.stop",
          actorId: id,
          finalState: result.newState,
          timestamp,
        }));
        yield* Ref.set(stoppedRef, true);
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        yield* Fiber.interrupt(snapshotFiber);
        yield* Fiber.interrupt(persistenceFiber);
        return;
      }
    }
  },
);
/**
 * Run spawn effects with inspection and tracing.
 * @internal
 */
const runSpawnEffectsWithInspection = Effect.fn("effect-machine.persistentActor.spawnEffects")(
  function* (machine, state, event, self, stateScope, actorId, inspector, system) {
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.effect",
      actorId,
      effectType: "spawn",
      state,
      timestamp,
    }));
    yield* runSpawnEffects(
      machine,
      state,
      event,
      self,
      stateScope,
      system,
      inspector === void 0
        ? void 0
        : (info) =>
            emitWithTimestamp(inspector, (timestamp) => ({
              type: "@machine.error",
              actorId,
              phase: info.phase,
              state: info.state,
              event: info.event,
              error: Cause.pretty(info.cause),
              timestamp,
            })),
    );
  },
);
/**
 * Persistence worker (journaling + metadata).
 */
const persistenceWorker = Effect.fn("effect-machine.persistentActor.persistenceWorker")(
  function* (queue) {
    while (true) yield* yield* Queue.take(queue);
  },
);
/**
 * Snapshot scheduler worker (runs in background).
 */
const snapshotWorker = Effect.fn("effect-machine.persistentActor.snapshotWorker")(
  function* (id, persistence, adapter, queue, enabledRef) {
    const driver = yield* Schedule.driver(persistence.snapshotSchedule);
    while (true) {
      const { state, version } = yield* Queue.take(queue);
      if (!(yield* Ref.get(enabledRef))) continue;
      if (
        !(yield* driver.next(state).pipe(
          Effect.match({
            onFailure: () => false,
            onSuccess: () => true,
          }),
        ))
      ) {
        yield* Ref.set(enabledRef, false);
        continue;
      }
      yield* saveSnapshot(id, state, version, persistence, adapter);
    }
  },
);
/**
 * Save a snapshot after state transition.
 * Called by snapshot scheduler.
 */
const saveSnapshot = Effect.fn("effect-machine.persistentActor.saveSnapshot")(
  function* (id, state, version, persistence, adapter) {
    const snapshot = {
      state,
      version,
      timestamp: yield* now,
    };
    yield* adapter
      .saveSnapshot(id, snapshot, persistence.stateSchema)
      .pipe(
        Effect.catchAll((e) => Effect.logWarning(`Failed to save snapshot for actor ${id}`, e)),
      );
  },
);
/**
 * Save or update actor metadata if adapter supports registry.
 * Called on spawn and state transitions.
 */
const saveMetadata = Effect.fn("effect-machine.persistentActor.saveMetadata")(
  function* (id, state, version, createdAt, persistence, adapter) {
    const save = adapter.saveMetadata;
    if (save === void 0) return;
    const lastActivityAt = yield* now;
    yield* save({
      id,
      machineType: persistence.machineType ?? "unknown",
      createdAt,
      lastActivityAt,
      version,
      stateTag: state._tag,
    }).pipe(
      Effect.catchAll((e) => Effect.logWarning(`Failed to save metadata for actor ${id}`, e)),
    );
  },
);
/**
 * Restore an actor from persistence.
 * Returns None if no persisted state exists.
 */
const restorePersistentActor = Effect.fn("effect-machine.persistentActor.restore")(
  function* (id, persistentMachine) {
    const adapter = yield* PersistenceAdapterTag;
    const { persistence } = persistentMachine;
    const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);
    const events = yield* adapter.loadEvents(
      id,
      persistence.eventSchema,
      Option.isSome(maybeSnapshot) ? maybeSnapshot.value.version : void 0,
    );
    if (Option.isNone(maybeSnapshot) && events.length === 0) return Option.none();
    const actor = yield* createPersistentActor(id, persistentMachine, maybeSnapshot, events);
    return Option.some(actor);
  },
);
//#endregion
export { createPersistentActor, restorePersistentActor };
