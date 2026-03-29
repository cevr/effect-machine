/**
 * Actor system: spawning, lifecycle, and event processing.
 *
 * Combines:
 * - ActorRef interface (running actor handle)
 * - ActorSystem service (spawn/stop/get actors)
 * - Actor creation and event loop
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  MutableHashMap,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Semaphore,
  ServiceMap,
  Stream,
  SubscriptionRef,
} from "effect";

import type { Machine, BuiltMachine } from "./machine.js";
import type { ReplyTypeBrand, ExtractReply } from "./internal/brands.js";
import type { GuardsDef, EffectsDef } from "./slot.js";
import type { Inspector } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import { resolveTransition } from "./internal/transition.js";
import type { ProcessEventHooks, ProcessEventResult } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import type { NoReplyError } from "./errors.js";
import { DuplicateActorError, ActorStoppedError } from "./errors.js";
import { createRuntime, type RuntimeQueuedEvent, type RuntimeHandle } from "./internal/runtime.js";

// Re-export for external use (cluster)
export { resolveTransition, runSpawnEffects, processEventCore } from "./internal/transition.js";
export type {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
} from "./internal/transition.js";

// ============================================================================
// QueuedEvent — re-export from runtime kernel
// ============================================================================

/** Discriminated mailbox request — alias for RuntimeQueuedEvent */
export type QueuedEvent<E> = RuntimeQueuedEvent<E>;

// ============================================================================
// ActorRef Interface
// ============================================================================

/**
 * Sync projection of ActorRef for non-Effect boundaries (React hooks, framework callbacks).
 */
export interface ActorRefSync<State extends { readonly _tag: string }, Event> {
  readonly send: (event: Event) => void;
  readonly stop: () => void;
  readonly snapshot: () => State;
  readonly matches: (tag: State["_tag"]) => boolean;
  readonly can: (event: Event) => boolean;
}

/**
 * Information about a successful transition.
 * Emitted on the `transitions` stream after each accepted event.
 */
export interface TransitionInfo<State, Event> {
  readonly fromState: State;
  readonly toState: State;
  readonly event: Event;
}

export interface ActorRef<State extends { readonly _tag: string }, Event> {
  readonly id: string;

  /** Send an event (fire-and-forget). */
  readonly send: (event: Event) => Effect.Effect<void>;

  /** Fire-and-forget alias for send (OTP gen_server:cast). */
  readonly cast: (event: Event) => Effect.Effect<void>;

  /**
   * Serialized request-reply (OTP gen_server:call).
   * Event is processed through the queue; caller gets ProcessEventResult back.
   */
  readonly call: (event: Event) => Effect.Effect<ProcessEventResult<State>>;

  /**
   * Typed request-reply. Accepts only events with a reply schema
   * (defined via `Event.reply()`). Return type is inferred from the schema.
   * Fails with NoReplyError if the handler doesn't provide a reply.
   */
  readonly ask: <E extends Event & ReplyTypeBrand<unknown>>(
    event: E,
  ) => Effect.Effect<ExtractReply<E>, NoReplyError | ActorStoppedError>;

  /** Observable state. */
  readonly state: SubscriptionRef.SubscriptionRef<State>;

  /** Stop the actor gracefully. */
  readonly stop: Effect.Effect<void>;

  /** Get current state snapshot. */
  readonly snapshot: Effect.Effect<State>;

  /** Check if current state matches tag. */
  readonly matches: (tag: State["_tag"]) => Effect.Effect<boolean>;

  /** Check if event can be handled in current state. */
  readonly can: (event: Event) => Effect.Effect<boolean>;

  /** Stream of state changes. */
  readonly changes: Stream.Stream<State>;

  /**
   * Stream of accepted transitions (edge stream).
   *
   * Emits `{ fromState, toState, event }` on every successful transition,
   * including same-state reenters. PubSub-backed — late subscribers miss
   * past edges. This is observational, not a durability guarantee.
   */
  readonly transitions: Stream.Stream<TransitionInfo<State, Event>>;

  /** Wait for a state matching predicate or variant (includes current snapshot). */
  readonly waitFor: {
    (predicate: (state: State) => boolean): Effect.Effect<State>;
    (state: { readonly _tag: State["_tag"] }): Effect.Effect<State>;
  };

  /** Wait for a final state (includes current snapshot). */
  readonly awaitFinal: Effect.Effect<State>;

  /** Send event and wait for predicate, state variant, or final state. */
  readonly sendAndWait: {
    (event: Event, predicate: (state: State) => boolean): Effect.Effect<State>;
    (event: Event, state: { readonly _tag: State["_tag"] }): Effect.Effect<State>;
    (event: Event): Effect.Effect<State>;
  };

  /** Subscribe to state changes (sync callback). Returns unsubscribe function. */
  readonly subscribe: (fn: (state: State) => void) => () => void;

  /** Sync helpers for non-Effect boundaries. */
  readonly sync: ActorRefSync<State, Event>;

  /** The actor system this actor belongs to. */
  readonly system: ActorSystem;

  /** Child actors spawned via `self.spawn` in this actor's handlers. */
  readonly children: ReadonlyMap<string, ActorRef<AnyState, unknown>>;
}

// ============================================================================
// ActorSystem Interface
// ============================================================================

/** Base type for stored actors (internal) */
type AnyState = { readonly _tag: string };

// ============================================================================
// System Observation Types
// ============================================================================

/**
 * Events emitted by the ActorSystem when actors are spawned or stopped.
 */
export type SystemEvent =
  | {
      readonly _tag: "ActorSpawned";
      readonly id: string;
      readonly actor: ActorRef<AnyState, unknown>;
    }
  | {
      readonly _tag: "ActorStopped";
      readonly id: string;
      readonly actor: ActorRef<AnyState, unknown>;
    };

/**
 * Listener callback for system events.
 */
export type SystemEventListener = (event: SystemEvent) => void;

/**
 * Actor system for managing actor lifecycles
 */
export interface ActorSystem {
  /**
   * Spawn a new actor with the given machine.
   *
   * @example
   * ```ts
   * const built = machine.build({ fetchData: ... })
   * const actor = yield* system.spawn("my-actor", built);
   * ```
   */
  readonly spawn: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: BuiltMachine<S, E, R>,
  ) => Effect.Effect<ActorRef<S, E>, DuplicateActorError, R>;

  /**
   * Get an existing actor by ID
   */
  readonly get: (id: string) => Effect.Effect<Option.Option<ActorRef<AnyState, unknown>>>;

  /**
   * Stop an actor by ID
   */
  readonly stop: (id: string) => Effect.Effect<boolean>;

  /**
   * Async stream of system events (actor spawned/stopped).
   * Each subscriber gets their own queue — late subscribers miss prior events.
   */
  readonly events: Stream.Stream<SystemEvent>;

  /**
   * Sync snapshot of all currently registered actors.
   * Returns a new Map on each access (not live).
   */
  readonly actors: ReadonlyMap<string, ActorRef<AnyState, unknown>>;

  /**
   * Subscribe to system events synchronously.
   * Returns an unsubscribe function.
   */
  readonly subscribe: (fn: SystemEventListener) => () => void;
}

/**
 * ActorSystem service tag
 */
export const ActorSystem = ServiceMap.Service<ActorSystem>("@effect/machine/ActorSystem");

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
 * Build core ActorRef methods.
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
  eventQueue: Queue.Queue<QueuedEvent<E>>,
  stoppedRef: Ref.Ref<boolean>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
  system: ActorSystem,
  childrenMap: ReadonlyMap<string, ActorRef<AnyState, unknown>>,
  pendingReplies: Set<Deferred.Deferred<unknown, unknown>>,
  transitionsPubSub?: PubSub.PubSub<TransitionInfo<S, E>>,
): ActorRef<S, E> => {
  const send = Effect.fn("effect-machine.actor.send")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (stopped) {
      return;
    }
    yield* Queue.offer(eventQueue, { _tag: "send", event });
  });

  const call = Effect.fn("effect-machine.actor.call")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (stopped) {
      const currentState = yield* SubscriptionRef.get(stateRef);
      return {
        newState: currentState,
        previousState: currentState,
        transitioned: false,
        lifecycleRan: false,
        isFinal: machine.finalStates.has(currentState._tag),
      } as ProcessEventResult<S>;
    }
    const reply = yield* Deferred.make<
      ProcessEventResult<{ readonly _tag: string }>,
      ActorStoppedError
    >();
    pendingReplies.add(reply as Deferred.Deferred<unknown, unknown>);
    yield* Queue.offer(eventQueue, {
      _tag: "call",
      event,
      reply: reply as Deferred.Deferred<ProcessEventResult<{ readonly _tag: string }>, unknown>,
    });
    return (yield* Deferred.await(reply).pipe(
      Effect.ensuring(
        Effect.sync(() => pendingReplies.delete(reply as Deferred.Deferred<unknown, unknown>)),
      ),
      Effect.catchTag("ActorStoppedError", () =>
        SubscriptionRef.get(stateRef).pipe(
          Effect.map((currentState) => ({
            newState: currentState,
            previousState: currentState,
            transitioned: false,
            lifecycleRan: false,
            isFinal: machine.finalStates.has(currentState._tag),
          })),
        ),
      ),
    )) as ProcessEventResult<S>;
  });

  const ask = Effect.fn("effect-machine.actor.ask")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (stopped) {
      return yield* new ActorStoppedError({ actorId: id });
    }
    const reply = yield* Deferred.make<unknown, NoReplyError | ActorStoppedError>();
    pendingReplies.add(reply as Deferred.Deferred<unknown, unknown>);
    yield* Queue.offer(eventQueue, {
      _tag: "ask",
      event,
      reply: reply as Deferred.Deferred<unknown, NoReplyError>,
    });
    return yield* Deferred.await(reply).pipe(
      Effect.ensuring(
        Effect.sync(() => pendingReplies.delete(reply as Deferred.Deferred<unknown, unknown>)),
      ),
    );
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

  const waitFor = Effect.fn("effect-machine.actor.waitFor")(function* (
    predicateOrState: ((state: S) => boolean) | { readonly _tag: S["_tag"] },
  ) {
    const predicate =
      typeof predicateOrState === "function" && !("_tag" in predicateOrState)
        ? predicateOrState
        : (s: S) => s._tag === (predicateOrState as { readonly _tag: string })._tag;

    // Check current state first — SubscriptionRef.get acquires/releases
    // the semaphore quickly (read-only), no deadlock risk.
    const current = yield* SubscriptionRef.get(stateRef);
    if (predicate(current)) return current;

    // Use sync listener + Deferred to avoid holding the SubscriptionRef
    // semaphore for the duration of a stream (which causes deadlock when
    // send triggers SubscriptionRef.set concurrently).
    const done = yield* Deferred.make<S>();
    // @effect-diagnostics runEffectInsideEffect:off
    const listener = (state: S) => {
      if (predicate(state)) {
        // Sync callback context — not inside Effect.gen
        Effect.runFork(Deferred.succeed(done, state));
      }
    };
    // @effect-diagnostics runEffectInsideEffect:on
    listeners.add(listener);

    // Re-check after subscribing to close the race window
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

  const sendAndWait = Effect.fn("effect-machine.actor.sendAndWait")(function* (
    event: E,
    predicateOrState?: ((state: S) => boolean) | { readonly _tag: S["_tag"] },
  ) {
    yield* send(event);
    if (predicateOrState !== undefined) {
      return yield* waitFor(predicateOrState);
    }
    return yield* awaitFinal;
  });

  return {
    id,
    send,
    cast: send,
    call,
    ask: ask as ActorRef<S, E>["ask"],
    state: stateRef,
    stop,
    snapshot,
    matches,
    can,
    changes: SubscriptionRef.changes(stateRef),
    transitions:
      transitionsPubSub !== undefined ? Stream.fromPubSub(transitionsPubSub) : Stream.empty,
    waitFor,
    awaitFinal,
    sendAndWait,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    sync: {
      send: (event) => {
        const stopped = Effect.runSync(Ref.get(stoppedRef));
        if (!stopped) {
          Effect.runSync(Queue.offer(eventQueue, { _tag: "send", event }));
        }
      },
      stop: () => Effect.runFork(stop),
      snapshot: () => Effect.runSync(SubscriptionRef.get(stateRef)),
      matches: (tag) => Effect.runSync(SubscriptionRef.get(stateRef))._tag === tag,
      can: (event) => {
        const state = Effect.runSync(SubscriptionRef.get(stateRef));
        return resolveTransition(machine, state, event) !== undefined;
      },
    },
    system,
    children: childrenMap,
  };
};

// ============================================================================
// Actor Creation — delegates to runtime kernel with actor-specific hooks
// ============================================================================

/** Build ProcessEventHooks from an inspector */
const buildInspectionHooks = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  actorId: string,
  inspector: Inspector<S, E>,
): ProcessEventHooks<S, E> => ({
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
});

/**
 * Create and start an actor for a machine.
 * Delegates to the shared runtime kernel with actor-specific lifecycle hooks.
 */
export const createActor = Effect.fn("effect-machine.actor.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  options?: { initialState?: S },
) {
  const initial: S = options?.initialState ?? machine.initial;
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", initial._tag);

  // Resolve actor system: use existing from context, or create implicit one
  const existingSystem = yield* Effect.serviceOption(ActorSystem);
  let system: ActorSystem;
  let implicitSystemScope: Scope.Closeable | undefined;

  if (Option.isSome(existingSystem)) {
    system = existingSystem.value;
  } else {
    const scope = yield* Scope.make();
    system = yield* make().pipe(Effect.provideService(Scope.Scope, scope));
    implicitSystemScope = scope;
  }

  // Get optional inspector from context
  const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
    | Inspector<S, E>
    | undefined;

  // Actor-specific state
  const childrenMap = new Map<string, ActorRef<AnyState, unknown>>();
  const pendingReplies = new Set<Deferred.Deferred<unknown, unknown>>();
  const listeners: Listeners<S> = new Set();
  const transitionsPubSub = yield* PubSub.unbounded<TransitionInfo<S, E>>();

  // Emit @machine.spawn inspection event
  yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
    type: "@machine.spawn",
    actorId: id,
    initialState: initial,
    timestamp,
  }));

  // Build hooks from inspector
  const hooks = inspectorValue !== undefined ? buildInspectionHooks(id, inspectorValue) : undefined;

  // Use initial state override if provided
  const machineWithState =
    initial !== machine.initial
      ? (Object.create(machine, {
          initial: { value: initial, enumerable: true },
        }) as typeof machine)
      : machine;

  // Track whether @machine.stop has been emitted (onFinal sets this to prevent double-emit in onShutdown)
  let stopEmitted = false;

  // Mutable ref for runtime.stateRef — needed because onShutdown closure
  // must reference the stateRef that createRuntime creates
  const runtimeRef: { stateRef: SubscriptionRef.SubscriptionRef<S> | undefined } = {
    stateRef: undefined,
  };

  // Create runtime with actor lifecycle hooks (skipFinalizer: true removes Scope requirement)
  const runtime = yield* createRuntime(machineWithState, system, {
    actorId: id,
    hooks,
    skipFinalizer: true,
    lifecycle: {
      onEvent:
        inspectorValue !== undefined
          ? (state: S, event: E) =>
              emitWithTimestamp(inspectorValue, (timestamp) => ({
                type: "@machine.event",
                actorId: id,
                state,
                event,
                timestamp,
              }))
          : undefined,
      onStateChange: (result, _event) =>
        Effect.gen(function* () {
          notifyListeners(listeners, result.newState);
          yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);
          if (result.lifecycleRan) {
            yield* Effect.annotateCurrentSpan(
              "effect_machine.state.from",
              result.previousState._tag,
            );
            yield* Effect.annotateCurrentSpan("effect_machine.state.to", result.newState._tag);
          }
        }),
      onProcessed: (result, event) =>
        result.transitioned
          ? PubSub.publish(transitionsPubSub, {
              fromState: result.previousState,
              toState: result.newState,
              event,
            }).pipe(Effect.asVoid)
          : Effect.void,
      onFinal:
        inspectorValue !== undefined
          ? (state: S) =>
              Effect.gen(function* () {
                stopEmitted = true;
                yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
                  type: "@machine.stop",
                  actorId: id,
                  finalState: state,
                  timestamp,
                }));
              })
          : undefined,
      onShutdown: () =>
        Effect.gen(function* () {
          if (!stopEmitted && runtimeRef.stateRef !== undefined) {
            const finalState = yield* SubscriptionRef.get(runtimeRef.stateRef);
            yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.stop",
              actorId: id,
              finalState,
              timestamp,
            }));
          }
          yield* settlePendingReplies(pendingReplies, id);
        }),
      onInitialSpawnEffects:
        inspectorValue !== undefined
          ? (state: S) =>
              emitWithTimestamp(inspectorValue, (timestamp) => ({
                type: "@machine.effect",
                actorId: id,
                effectType: "spawn",
                state,
                timestamp,
              }))
          : undefined,
    },
    wrapProcess: (state, event, inner) =>
      Effect.withSpan("effect-machine.event.process", {
        attributes: {
          "effect_machine.actor.id": id,
          "effect_machine.state.current": state._tag,
          "effect_machine.event.type": event._tag,
        },
      })(
        inner.pipe(
          Effect.tap((r) =>
            Effect.annotateCurrentSpan("effect_machine.transition.matched", r.result.transitioned),
          ),
        ),
      ),
    onChildSpawned: (childId, child) =>
      Effect.gen(function* () {
        childrenMap.set(childId, child as unknown as ActorRef<AnyState, unknown>);
        const maybeScope = yield* Effect.serviceOption(Scope.Scope);
        if (Option.isSome(maybeScope)) {
          yield* Scope.addFinalizer(
            maybeScope.value,
            Effect.sync(() => {
              childrenMap.delete(childId);
            }),
          );
        }
      }),
  }) as Effect.Effect<RuntimeHandle<S, E>>;

  // Wire the mutable ref now that runtime is created
  runtimeRef.stateRef = runtime.stateRef;

  // Build actor stop — wraps runtime.stop with implicit system teardown
  const stop = Effect.gen(function* () {
    yield* runtime.stop;
    if (implicitSystemScope !== undefined) {
      yield* Scope.close(implicitSystemScope, Exit.void);
    }
  }).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid);

  return buildActorRefCore(
    id,
    machine,
    runtime.stateRef,
    runtime._queue,
    runtime._stoppedRef,
    listeners,
    stop,
    system,
    childrenMap,
    pendingReplies,
    transitionsPubSub,
  );
});

/** Fail all pending call/ask Deferreds with ActorStoppedError. Safe to call multiple times. */
export const settlePendingReplies = (
  pendingReplies: Set<Deferred.Deferred<unknown, unknown>>,
  actorId: string,
) =>
  Effect.sync(() => {
    const error = new ActorStoppedError({ actorId });
    for (const deferred of pendingReplies) {
      // Deferred.fail returns false if already completed — safe to double-settle
      Effect.runFork(Deferred.fail(deferred, error));
    }
    pendingReplies.clear();
  });

// ============================================================================
// ActorSystem Implementation
// ============================================================================

/** Notify all system event listeners (sync). */
const notifySystemListeners = (listeners: Set<SystemEventListener>, event: SystemEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignore listener failures to avoid crashing the system
    }
  }
};

const make = Effect.fn("effect-machine.actorSystem.make")(function* () {
  // MutableHashMap for O(1) spawn/stop/get operations
  const actorsMap = MutableHashMap.empty<string, ActorRef<AnyState, unknown>>();
  const spawnGate = yield* Semaphore.make(1);
  const withSpawnGate = spawnGate.withPermits(1);

  // Observable infrastructure
  const eventPubSub = yield* PubSub.unbounded<SystemEvent>();
  const eventListeners = new Set<SystemEventListener>();

  const emitSystemEvent = (event: SystemEvent): Effect.Effect<void> =>
    Effect.sync(() => notifySystemListeners(eventListeners, event)).pipe(
      Effect.andThen(PubSub.publish(eventPubSub, event)),
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    );

  // Stop all actors on system teardown (no events — PubSub is about to die)
  yield* Effect.addFinalizer(() => {
    const stops: Effect.Effect<void>[] = [];
    MutableHashMap.forEach(actorsMap, (actor) => {
      stops.push(actor.stop);
    });
    return Effect.all(stops, { concurrency: "unbounded" }).pipe(
      Effect.andThen(PubSub.shutdown(eventPubSub)),
      Effect.asVoid,
    );
  });

  /** Check for duplicate ID, register actor, attach scope cleanup if available */
  const registerActor = Effect.fn("effect-machine.actorSystem.register")(function* <
    T extends { stop: Effect.Effect<void> },
  >(id: string, actor: T) {
    // Check if actor already exists
    if (MutableHashMap.has(actorsMap, id)) {
      // Stop the newly created actor to avoid leaks
      yield* actor.stop;
      return yield* new DuplicateActorError({ actorId: id });
    }

    const actorRef = actor as unknown as ActorRef<AnyState, unknown>;

    // Register it - O(1)
    MutableHashMap.set(actorsMap, id, actorRef);

    // Emit spawned event
    yield* emitSystemEvent({ _tag: "ActorSpawned", id, actor: actorRef });

    // If scope available, attach per-actor cleanup
    const maybeScope = yield* Effect.serviceOption(Scope.Scope);
    if (Option.isSome(maybeScope)) {
      yield* Scope.addFinalizer(
        maybeScope.value,
        Effect.gen(function* () {
          // Guard: only emit if still registered (system.stop may have already removed it)
          if (MutableHashMap.has(actorsMap, id)) {
            yield* emitSystemEvent({ _tag: "ActorStopped", id, actor: actorRef });
            MutableHashMap.remove(actorsMap, id);
          }
          yield* actor.stop;
        }),
      );
    }

    return actor;
  });

  const spawnRegular = Effect.fn("effect-machine.actorSystem.spawnRegular")(function* <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(id: string, built: BuiltMachine<S, E, R>) {
    if (MutableHashMap.has(actorsMap, id)) {
      return yield* new DuplicateActorError({ actorId: id });
    }
    // Create and register the actor
    const actor = yield* createActor(id, built._inner);
    return yield* registerActor(id, actor);
  });

  const spawn = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: BuiltMachine<S, E, R>,
  ): Effect.Effect<ActorRef<S, E>, DuplicateActorError, R> =>
    withSpawnGate(spawnRegular(id, machine)) as Effect.Effect<
      ActorRef<S, E>,
      DuplicateActorError,
      R
    >;

  const get = Effect.fn("effect-machine.actorSystem.get")(function* (id: string) {
    return yield* Effect.sync(() => MutableHashMap.get(actorsMap, id));
  });

  const stop = Effect.fn("effect-machine.actorSystem.stop")(function* (id: string) {
    const maybeActor = MutableHashMap.get(actorsMap, id);
    if (Option.isNone(maybeActor)) {
      return false;
    }

    const actor = maybeActor.value;
    // Remove first to prevent scope finalizer double-emit
    MutableHashMap.remove(actorsMap, id);
    yield* emitSystemEvent({ _tag: "ActorStopped", id, actor });
    yield* actor.stop;
    return true;
  });

  return ActorSystem.of({
    spawn,
    get,
    stop,
    events: Stream.fromPubSub(eventPubSub),
    get actors() {
      const snapshot = new Map<string, ActorRef<AnyState, unknown>>();
      MutableHashMap.forEach(actorsMap, (actor, id) => {
        snapshot.set(id, actor);
      });
      return snapshot as ReadonlyMap<string, ActorRef<AnyState, unknown>>;
    },
    subscribe: (fn) => {
      eventListeners.add(fn);
      return () => {
        eventListeners.delete(fn);
      };
    },
  });
});

/**
 * Create an ActorSystem instance. Must be run in a Scope.
 * @internal — use Default layer for normal usage
 */
export const makeSystem = make;

/**
 * Default ActorSystem layer
 */
export const Default = Layer.effect(ActorSystem, make());
