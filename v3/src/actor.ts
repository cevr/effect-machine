/**
 * Actor system: spawning, lifecycle, and event processing.
 *
 * Combines:
 * - ActorRef interface (running actor handle)
 * - ActorSystem service (spawn/stop/get actors)
 * - Actor creation (delegates to runtime kernel)
 */
import {
  Cause,
  Context,
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
  Stream,
  SubscriptionRef,
} from "effect";

import type { Machine } from "./machine.js";
import { materializeMachine } from "./machine.js";
import type { ReplyTypeBrand, ExtractReply } from "./internal/brands.js";
import type { GuardsDef, EffectsDef } from "./slot.js";
import type { NoReplyError } from "./errors.js";
import { DuplicateActorError, ActorStoppedError } from "./errors.js";
import type { Inspector } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import { resolveTransition } from "./internal/transition.js";
import type {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
} from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import { createRuntime, type RuntimeQueuedEvent, type RuntimeHandle } from "./internal/runtime.js";

// Re-export for external use (cluster, persistence)
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

  /**
   * Watch another actor. Returns an Effect that completes when the watched actor stops.
   * Built on system.events — subscribes then checks current stopped state to avoid race.
   */
  readonly watch: (other: {
    readonly id: string;
    readonly system: ActorSystem;
  }) => Effect.Effect<void>;

  /**
   * Drain: process all remaining events in the queue, then stop.
   * Unlike `stop` (which interrupts immediately), `drain` lets the actor finish its work.
   */
  readonly drain: Effect.Effect<void>;

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
   * const actor = yield* system.spawn("my-actor", machine, {
   *   slots: { fetchData: ({ url }) => Http.get(url) },
   * });
   * ```
   */
  readonly spawn: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { slots?: Record<string, any> },
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
    const listener = (state: S) => {
      if (predicate(state)) {
        Effect.runFork(Deferred.succeed(done, state));
      }
    };
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
    changes: stateRef.changes,
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
    watch: (other) =>
      Effect.gen(function* () {
        // Use the watched actor's system (supports cross-system watching)
        const otherSystem = other.system;
        const done = yield* Deferred.make<void>();
        const unsub = otherSystem.subscribe((event) => {
          if (event._tag === "ActorStopped" && event.id === other.id) {
            Effect.runFork(Deferred.succeed(done, undefined));
          }
        });
        // Check if actor is already not in its system (may have stopped before subscribe)
        const maybeOther = yield* otherSystem.get(other.id);
        if (Option.isNone(maybeOther)) {
          unsub();
          return;
        }
        yield* Deferred.await(done);
        unsub();
      }).pipe(Effect.asVoid) as Effect.Effect<void>,
    drain: Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (stopped) return;
      const done = yield* Deferred.make<void, never>();
      yield* Queue.offer(eventQueue, { _tag: "drain" as const, done });
      yield* Deferred.await(done);
    }).pipe(Effect.asVoid) as Effect.Effect<void>,
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
// Actor Creation — delegates to runtime kernel
// ============================================================================

/**
 * Create and start an actor for a machine.
 * Uses the shared runtime kernel with lifecycle hooks for actor-specific concerns.
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

  // Resolve actor system: use existing from context, or create implicit one
  const existingSystem = yield* Effect.serviceOption(ActorSystem);
  let system: ActorSystem;
  let implicitSystemScope: Scope.CloseableScope | undefined;

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

  // Pending reply tracking — registered before enqueue, settled on stop
  const pendingReplies = new Set<Deferred.Deferred<unknown, unknown>>();

  // PubSub for transition observation (actor.transitions stream)
  const transitionsPubSub = yield* PubSub.unbounded<TransitionInfo<S, E>>();

  // Listeners for sync subscriptions
  const listeners: Listeners<S> = new Set();
  const childrenMap = new Map<string, ActorRef<AnyState, unknown>>();

  // Emit spawn event
  yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
    type: "@machine.spawn",
    actorId: id,
    initialState: initial,
    timestamp,
  }));
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", initial._tag);

  // Set initial state override if provided
  const machineWithState =
    initial !== machine.initial
      ? Object.create(machine, { initial: { value: initial, enumerable: true } })
      : machine;

  // Track whether @machine.stop was already emitted (by onFinal)
  let stopEmitted = false;

  // runtimeRef: mutable reference to the runtime handle, set after createRuntime completes.
  // Needed because onShutdown references runtime.stateRef but runtime is the result of createRuntime.
  const runtimeRef: { current: RuntimeHandle<S, E> | undefined } = { current: undefined };

  // Build inspection hooks for processEventCore
  const processHooks: ProcessEventHooks<S, E> | undefined =
    inspectorValue === undefined
      ? undefined
      : {
          onSpawnEffect: (state) =>
            emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.effect",
              actorId: id,
              effectType: "spawn",
              state,
              timestamp,
            })),
          onTransition: (from, to, ev) =>
            emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.transition",
              actorId: id,
              fromState: from,
              toState: to,
              event: ev,
              timestamp,
            })),
          onError: (info) =>
            emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.error",
              actorId: id,
              phase: info.phase,
              state: info.state,
              event: info.event,
              error: Cause.pretty(info.cause),
              timestamp,
            })),
        };

  // Create runtime with lifecycle hooks
  const runtime = yield* createRuntime(machineWithState, system, {
    actorId: id,
    hooks: processHooks,
    skipFinalizer: true,
    lifecycle: {
      onEvent:
        inspectorValue !== undefined
          ? (state, event) =>
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
          yield* Effect.annotateCurrentSpan("effect_machine.state.from", result.previousState._tag);
          yield* Effect.annotateCurrentSpan("effect_machine.state.to", result.newState._tag);
          yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);
        }),
      onProcessed: (result, event) =>
        PubSub.publish(transitionsPubSub, {
          fromState: result.previousState,
          toState: result.newState,
          event,
        }).pipe(Effect.asVoid),
      onFinal: (state) =>
        Effect.gen(function* () {
          stopEmitted = true;
          yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
            type: "@machine.stop",
            actorId: id,
            finalState: state,
            timestamp,
          }));
        }),
      onShutdown: () =>
        Effect.gen(function* () {
          if (!stopEmitted) {
            const rt = runtimeRef.current;
            const finalState = rt !== undefined ? yield* SubscriptionRef.get(rt.stateRef) : initial;
            yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.stop",
              actorId: id,
              finalState,
              timestamp,
            }));
          }
          // Settle pending call/ask Deferreds
          yield* settlePendingReplies(pendingReplies, id);
          // Tear down implicit system if created
          if (implicitSystemScope !== undefined) {
            yield* Scope.close(implicitSystemScope, Exit.void);
          }
        }),
      onInitialSpawnEffects:
        inspectorValue !== undefined
          ? (state) =>
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
      })(inner),
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

  runtimeRef.current = runtime;

  const stateRef = runtime.stateRef;
  const stoppedRef = runtime._stoppedRef;
  const eventQueue = runtime._queue;

  // Build actor stop — delegates to runtime.stop which calls lifecycle.onShutdown
  const stop = runtime.stop.pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid);

  return buildActorRefCore(
    id,
    machine,
    stateRef,
    eventQueue,
    stoppedRef,
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
  const spawnGate = yield* Effect.makeSemaphore(1);
  const withSpawnGate = spawnGate.withPermits(1);

  // Observable infrastructure
  const eventPubSub = yield* PubSub.unbounded<SystemEvent>();
  const eventListeners = new Set<SystemEventListener>();

  const emitSystemEvent = (event: SystemEvent): Effect.Effect<void> =>
    Effect.sync(() => notifySystemListeners(eventListeners, event)).pipe(
      Effect.zipRight(PubSub.publish(eventPubSub, event)),
      Effect.catchAllCause(() => Effect.void),
      Effect.asVoid,
    );

  // Stop all actors on system teardown (no events — PubSub is about to die)
  yield* Effect.addFinalizer(() => {
    const stops: Effect.Effect<void>[] = [];
    MutableHashMap.forEach(actorsMap, (actor) => {
      stops.push(actor.stop);
    });
    return Effect.all(stops, { concurrency: "unbounded" }).pipe(
      Effect.zipRight(PubSub.shutdown(eventPubSub)),
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
  >(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { slots?: Record<string, any> },
  ) {
    if (MutableHashMap.has(actorsMap, id)) {
      return yield* new DuplicateActorError({ actorId: id });
    }
    // Materialize slots if provided, then create and register the actor
    const materialized = materializeMachine(machine, options?.slots);
    const actor = yield* createActor(id, materialized);
    return yield* registerActor(id, actor);
  });

  const spawn = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, any, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { slots?: Record<string, any> },
  ): Effect.Effect<ActorRef<S, E>, DuplicateActorError, R> =>
    withSpawnGate(spawnRegular(id, machine, options)) as Effect.Effect<
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
 * Default ActorSystem layer
 */
export const Default = Layer.scoped(ActorSystem, make());
