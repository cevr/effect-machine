import { Inspector } from "./inspection.js";
import { INTERNAL_INIT_EVENT } from "./internal/utils.js";
import { DuplicateActorError } from "./errors.js";
import { isPersistentMachine } from "./persistence/persistent-machine.js";
import { processEventCore, resolveTransition, runSpawnEffects } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import { PersistenceAdapterTag, PersistenceError } from "./persistence/adapter.js";
import { createPersistentActor, restorePersistentActor } from "./persistence/persistent-actor.js";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  MutableHashMap,
  Option,
  PubSub,
  Queue,
  Ref,
  Runtime,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

//#region src-v3/actor.ts
/**
 * Actor system: spawning, lifecycle, and event processing.
 *
 * Combines:
 * - ActorRef interface (running actor handle)
 * - ActorSystem service (spawn/stop/get actors)
 * - Actor creation and event loop
 */
/**
 * ActorSystem service tag
 */
const ActorSystem = Context.GenericTag("@effect/machine/ActorSystem");
/**
 * Notify all listeners of state change.
 */
const notifyListeners = (listeners, state) => {
  for (const listener of listeners)
    try {
      listener(state);
    } catch {}
};
/**
 * Build core ActorRef methods shared between regular and persistent actors.
 */
const buildActorRefCore = (
  id,
  machine,
  stateRef,
  eventQueue,
  stoppedRef,
  listeners,
  stop,
  system,
  childrenMap,
) => {
  const send = Effect.fn("effect-machine.actor.send")(function* (event) {
    if (yield* Ref.get(stoppedRef)) return;
    yield* Queue.offer(eventQueue, event);
  });
  const snapshot = SubscriptionRef.get(stateRef).pipe(
    Effect.withSpan("effect-machine.actor.snapshot"),
  );
  const matches = Effect.fn("effect-machine.actor.matches")(function* (tag) {
    return (yield* SubscriptionRef.get(stateRef))._tag === tag;
  });
  const can = Effect.fn("effect-machine.actor.can")(function* (event) {
    return resolveTransition(machine, yield* SubscriptionRef.get(stateRef), event) !== void 0;
  });
  const waitFor = Effect.fn("effect-machine.actor.waitFor")(function* (predicateOrState) {
    const predicate =
      typeof predicateOrState === "function" && !("_tag" in predicateOrState)
        ? predicateOrState
        : (s) => s._tag === predicateOrState._tag;
    const current = yield* SubscriptionRef.get(stateRef);
    if (predicate(current)) return current;
    const done = yield* Deferred.make();
    const rt = yield* Effect.runtime();
    const runFork = Runtime.runFork(rt);
    const listener = (state) => {
      if (predicate(state)) runFork(Deferred.succeed(done, state));
    };
    listeners.add(listener);
    const afterSubscribe = yield* SubscriptionRef.get(stateRef);
    if (predicate(afterSubscribe)) {
      listeners.delete(listener);
      return afterSubscribe;
    }
    const result = yield* Deferred.await(done);
    listeners.delete(listener);
    return result;
  });
  const awaitFinal = waitFor((state) => machine.finalStates.has(state._tag)).pipe(
    Effect.withSpan("effect-machine.actor.awaitFinal"),
  );
  const sendAndWait = Effect.fn("effect-machine.actor.sendAndWait")(
    function* (event, predicateOrState) {
      yield* send(event);
      if (predicateOrState !== void 0) return yield* waitFor(predicateOrState);
      return yield* awaitFinal;
    },
  );
  return {
    id,
    send,
    state: stateRef,
    stop,
    stopSync: () => Effect.runFork(stop),
    snapshot,
    snapshotSync: () => Effect.runSync(SubscriptionRef.get(stateRef)),
    matches,
    matchesSync: (tag) => Effect.runSync(SubscriptionRef.get(stateRef))._tag === tag,
    can,
    canSync: (event) => {
      return (
        resolveTransition(machine, Effect.runSync(SubscriptionRef.get(stateRef)), event) !== void 0
      );
    },
    changes: stateRef.changes,
    waitFor,
    awaitFinal,
    sendAndWait,
    sendSync: (event) => {
      if (!Effect.runSync(Ref.get(stoppedRef))) Effect.runSync(Queue.offer(eventQueue, event));
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    system,
    children: childrenMap,
  };
};
/**
 * Create and start an actor for a machine
 */
const createActor = Effect.fn("effect-machine.actor.spawn")(function* (id, machine) {
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
  const existingSystem = yield* Effect.serviceOption(ActorSystem);
  let system;
  let implicitSystemScope;
  if (Option.isSome(existingSystem)) system = existingSystem.value;
  else {
    const scope = yield* Scope.make();
    system = yield* make().pipe(Effect.provideService(Scope.Scope, scope));
    implicitSystemScope = scope;
  }
  const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(Inspector));
  const eventQueue = yield* Queue.unbounded();
  const stoppedRef = yield* Ref.make(false);
  const childrenMap = /* @__PURE__ */ new Map();
  const self = {
    send: Effect.fn("effect-machine.actor.self.send")(function* (event) {
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
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", machine.initial._tag);
  yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
    type: "@machine.spawn",
    actorId: id,
    initialState: machine.initial,
    timestamp,
  }));
  const stateRef = yield* SubscriptionRef.make(machine.initial);
  const listeners = /* @__PURE__ */ new Set();
  const backgroundFibers = [];
  const initEvent = { _tag: INTERNAL_INIT_EVENT };
  const ctx = {
    state: machine.initial,
    event: initEvent,
    self,
    system,
  };
  const { effects: effectSlots } = machine._slots;
  for (const bg of machine.backgroundEffects) {
    const fiber = yield* Effect.forkDaemon(
      bg
        .handler({
          state: machine.initial,
          event: initEvent,
          self,
          effects: effectSlots,
          system,
        })
        .pipe(Effect.provideService(machine.Context, ctx)),
    );
    backgroundFibers.push(fiber);
  }
  const stateScopeRef = { current: yield* Scope.make() };
  yield* runSpawnEffectsWithInspection(
    machine,
    machine.initial,
    initEvent,
    self,
    stateScopeRef.current,
    id,
    inspectorValue,
    system,
  );
  if (machine.finalStates.has(machine.initial._tag)) {
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
      type: "@machine.stop",
      actorId: id,
      finalState: machine.initial,
      timestamp,
    }));
    yield* Ref.set(stoppedRef, true);
    if (implicitSystemScope !== void 0) yield* Scope.close(implicitSystemScope, Exit.void);
    return buildActorRefCore(
      id,
      machine,
      stateRef,
      eventQueue,
      stoppedRef,
      listeners,
      Ref.set(stoppedRef, true).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid),
      system,
      childrenMap,
    );
  }
  const loopFiber = yield* Effect.forkDaemon(
    eventLoop(
      machine,
      stateRef,
      eventQueue,
      stoppedRef,
      self,
      listeners,
      backgroundFibers,
      stateScopeRef,
      id,
      inspectorValue,
      system,
    ),
  );
  return buildActorRefCore(
    id,
    machine,
    stateRef,
    eventQueue,
    stoppedRef,
    listeners,
    Effect.gen(function* () {
      const finalState = yield* SubscriptionRef.get(stateRef);
      yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
        type: "@machine.stop",
        actorId: id,
        finalState,
        timestamp,
      }));
      yield* Ref.set(stoppedRef, true);
      yield* Fiber.interrupt(loopFiber);
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
      if (implicitSystemScope !== void 0) yield* Scope.close(implicitSystemScope, Exit.void);
    }).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid),
    system,
    childrenMap,
  );
});
/**
 * Main event loop for the actor
 */
const eventLoop = Effect.fn("effect-machine.actor.eventLoop")(
  function* (
    machine,
    stateRef,
    eventQueue,
    stoppedRef,
    self,
    listeners,
    backgroundFibers,
    stateScopeRef,
    actorId,
    inspector,
    system,
  ) {
    while (true) {
      const event = yield* Queue.take(eventQueue);
      const currentState = yield* SubscriptionRef.get(stateRef);
      if (
        yield* Effect.withSpan("effect-machine.event.process", {
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
            system,
          ),
        )
      ) {
        yield* Ref.set(stoppedRef, true);
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
        return;
      }
    }
  },
);
/**
 * Process a single event, returning true if the actor should stop.
 * Wraps processEventCore with actor-specific concerns (inspection, listeners, state ref).
 */
const processEvent = Effect.fn("effect-machine.actor.processEvent")(
  function* (
    machine,
    currentState,
    event,
    stateRef,
    self,
    listeners,
    stateScopeRef,
    actorId,
    inspector,
    system,
  ) {
    yield* emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.event",
      actorId,
      state: currentState,
      event,
      timestamp,
    }));
    const result = yield* processEventCore(
      machine,
      currentState,
      event,
      self,
      stateScopeRef,
      system,
      inspector === void 0
        ? void 0
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
            onError: (info) =>
              emitWithTimestamp(inspector, (timestamp) => ({
                type: "@machine.error",
                actorId,
                phase: info.phase,
                state: info.state,
                event: info.event,
                error: Cause.pretty(info.cause),
                timestamp,
              })),
          },
    );
    if (!result.transitioned) {
      yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
      return false;
    }
    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);
    yield* SubscriptionRef.set(stateRef, result.newState);
    notifyListeners(listeners, result.newState);
    if (result.lifecycleRan) {
      yield* Effect.annotateCurrentSpan("effect_machine.state.from", result.previousState._tag);
      yield* Effect.annotateCurrentSpan("effect_machine.state.to", result.newState._tag);
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
  },
);
/**
 * Run spawn effects with actor-specific inspection and tracing.
 * Wraps the core runSpawnEffects with inspection events and spans.
 * @internal
 */
const runSpawnEffectsWithInspection = Effect.fn("effect-machine.actor.spawnEffects")(
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
/** Notify all system event listeners (sync). */
const notifySystemListeners = (listeners, event) => {
  for (const listener of listeners)
    try {
      listener(event);
    } catch {}
};
const make = Effect.fn("effect-machine.actorSystem.make")(function* () {
  const actorsMap = MutableHashMap.empty();
  const withSpawnGate = (yield* Effect.makeSemaphore(1)).withPermits(1);
  const eventPubSub = yield* PubSub.unbounded();
  const eventListeners = /* @__PURE__ */ new Set();
  const emitSystemEvent = (event) =>
    Effect.sync(() => notifySystemListeners(eventListeners, event)).pipe(
      Effect.andThen(PubSub.publish(eventPubSub, event)),
      Effect.catchAllCause(() => Effect.void),
      Effect.asVoid,
    );
  yield* Effect.addFinalizer(() => {
    const stops = [];
    MutableHashMap.forEach(actorsMap, (actor) => {
      stops.push(actor.stop);
    });
    return Effect.all(stops, { concurrency: "unbounded" }).pipe(
      Effect.andThen(PubSub.shutdown(eventPubSub)),
      Effect.asVoid,
    );
  });
  /** Check for duplicate ID, register actor, attach scope cleanup if available */
  const registerActor = Effect.fn("effect-machine.actorSystem.register")(function* (id, actor) {
    if (MutableHashMap.has(actorsMap, id)) {
      yield* actor.stop;
      return yield* new DuplicateActorError({ actorId: id });
    }
    const actorRef = actor;
    MutableHashMap.set(actorsMap, id, actorRef);
    yield* emitSystemEvent({
      _tag: "ActorSpawned",
      id,
      actor: actorRef,
    });
    const maybeScope = yield* Effect.serviceOption(Scope.Scope);
    if (Option.isSome(maybeScope))
      yield* Scope.addFinalizer(
        maybeScope.value,
        Effect.gen(function* () {
          if (MutableHashMap.has(actorsMap, id)) {
            yield* emitSystemEvent({
              _tag: "ActorStopped",
              id,
              actor: actorRef,
            });
            MutableHashMap.remove(actorsMap, id);
          }
          yield* actor.stop;
        }),
      );
    return actor;
  });
  const spawnRegular = Effect.fn("effect-machine.actorSystem.spawnRegular")(function* (id, built) {
    if (MutableHashMap.has(actorsMap, id)) return yield* new DuplicateActorError({ actorId: id });
    return yield* registerActor(id, yield* createActor(id, built._inner));
  });
  const spawnPersistent = Effect.fn("effect-machine.actorSystem.spawnPersistent")(
    function* (id, persistentMachine) {
      if (MutableHashMap.has(actorsMap, id)) return yield* new DuplicateActorError({ actorId: id });
      const adapter = yield* PersistenceAdapterTag;
      const maybeSnapshot = yield* adapter.loadSnapshot(
        id,
        persistentMachine.persistence.stateSchema,
      );
      return yield* registerActor(
        id,
        yield* createPersistentActor(
          id,
          persistentMachine,
          maybeSnapshot,
          yield* adapter.loadEvents(
            id,
            persistentMachine.persistence.eventSchema,
            Option.isSome(maybeSnapshot) ? maybeSnapshot.value.version : void 0,
          ),
        ),
      );
    },
  );
  const spawnImpl = Effect.fn("effect-machine.actorSystem.spawn")(function* (id, machine) {
    if (isPersistentMachine(machine)) return yield* spawnPersistent(id, machine);
    return yield* spawnRegular(id, machine);
  });
  function spawn(id, machine) {
    return withSpawnGate(spawnImpl(id, machine));
  }
  const restoreImpl = Effect.fn("effect-machine.actorSystem.restore")(
    function* (id, persistentMachine) {
      const maybeActor = yield* restorePersistentActor(id, persistentMachine);
      if (Option.isSome(maybeActor)) yield* registerActor(id, maybeActor.value);
      return maybeActor;
    },
  );
  const restore = (id, persistentMachine) => withSpawnGate(restoreImpl(id, persistentMachine));
  const get = Effect.fn("effect-machine.actorSystem.get")(function* (id) {
    return yield* Effect.sync(() => MutableHashMap.get(actorsMap, id));
  });
  const stop = Effect.fn("effect-machine.actorSystem.stop")(function* (id) {
    const maybeActor = MutableHashMap.get(actorsMap, id);
    if (Option.isNone(maybeActor)) return false;
    const actor = maybeActor.value;
    MutableHashMap.remove(actorsMap, id);
    yield* emitSystemEvent({
      _tag: "ActorStopped",
      id,
      actor,
    });
    yield* actor.stop;
    return true;
  });
  const listPersisted = Effect.fn("effect-machine.actorSystem.listPersisted")(function* () {
    const adapter = yield* PersistenceAdapterTag;
    if (adapter.listActors === void 0) return [];
    return yield* adapter.listActors();
  });
  const restoreMany = Effect.fn("effect-machine.actorSystem.restoreMany")(
    function* (ids, persistentMachine) {
      const restored = [];
      const failed = [];
      for (const id of ids) {
        if (MutableHashMap.has(actorsMap, id)) continue;
        const result = yield* Effect.either(restore(id, persistentMachine));
        if (result._tag === "Left")
          failed.push({
            id,
            error: result.left,
          });
        else if (Option.isSome(result.right)) restored.push(result.right.value);
        else
          failed.push({
            id,
            error: new PersistenceError({
              operation: "restore",
              actorId: id,
              message: "No persisted state found",
            }),
          });
      }
      return {
        restored,
        failed,
      };
    },
  );
  const restoreAll = Effect.fn("effect-machine.actorSystem.restoreAll")(
    function* (persistentMachine, options) {
      const adapter = yield* PersistenceAdapterTag;
      if (adapter.listActors === void 0)
        return {
          restored: [],
          failed: [],
        };
      const machineType = persistentMachine.persistence.machineType;
      if (machineType === void 0)
        return yield* new PersistenceError({
          operation: "restoreAll",
          actorId: "*",
          message: "restoreAll requires explicit machineType in persistence config",
        });
      let filtered = (yield* adapter.listActors()).filter(
        (meta) => meta.machineType === machineType,
      );
      if (options?.filter !== void 0) filtered = filtered.filter(options.filter);
      return yield* restoreMany(
        filtered.map((meta) => meta.id),
        persistentMachine,
      );
    },
  );
  return ActorSystem.of({
    spawn,
    restore,
    get,
    stop,
    events: Stream.fromPubSub(eventPubSub),
    get actors() {
      const snapshot = /* @__PURE__ */ new Map();
      MutableHashMap.forEach(actorsMap, (actor, id) => {
        snapshot.set(id, actor);
      });
      return snapshot;
    },
    subscribe: (fn) => {
      eventListeners.add(fn);
      return () => {
        eventListeners.delete(fn);
      };
    },
    listPersisted,
    restoreMany,
    restoreAll,
  });
});
/**
 * Default ActorSystem layer
 */
const Default = Layer.scoped(ActorSystem, make());

//#endregion
export {
  ActorSystem,
  Default,
  buildActorRefCore,
  createActor,
  notifyListeners,
  processEventCore,
  resolveTransition,
  runSpawnEffects,
};
