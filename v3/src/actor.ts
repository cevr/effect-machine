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
  Fiber,
  Layer,
  MutableHashMap,
  Option,
  PubSub,
  Queue,
  Ref,
  Schedule,
  Scope,
  Context,
  Stream,
  SubscriptionRef,
} from "effect";

import type { Machine, PersistConfig } from "./machine.js";
import { materializeMachine } from "./machine.js";
import type { ActorExit, Supervision } from "./supervision.js";
import type { ReplyTypeBrand, ExtractReply } from "./internal/brands.js";
import type { SlotsDef, ProvideSlots } from "./slot.js";
import type { Inspector } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import { resolveTransition } from "./internal/transition.js";
import type { ProcessEventHooks, ProcessEventResult } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import type { NoReplyError } from "./errors.js";
import { DuplicateActorError, ActorStoppedError } from "./errors.js";
import {
  createRuntime,
  type RuntimeLifecycleHooks,
  type RuntimeQueuedEvent,
  type RuntimeHandle,
} from "./internal/runtime.js";

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

  /**
   * Wait for this actor's terminal exit. Resolves with the exit reason.
   * Set exactly once when the actor terminates (final, stop, drain, or defect).
   */
  readonly awaitExit: Effect.Effect<ActorExit<State>>;

  /**
   * Watch another actor. Returns an Effect that resolves with the exit reason
   * when the watched actor terminally stops. Ignores restarts (Step 3).
   * Built on the other actor's exitDeferred — authoritative, not system events.
   */
  readonly watch: (other: {
    readonly id: string;
    readonly awaitExit: Effect.Effect<ActorExit<unknown>>;
  }) => Effect.Effect<ActorExit<unknown>>;

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
      readonly _tag: "ActorRestarted";
      readonly id: string;
      readonly actor: ActorRef<AnyState, unknown>;
      readonly generation: number;
      readonly exit: ActorExit<unknown>;
    }
  | {
      readonly _tag: "ActorStopped";
      readonly id: string;
      readonly actor: ActorRef<AnyState, unknown>;
      readonly exit: ActorExit<unknown>;
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
   * const actor = yield* system.spawn("my-actor", machine);
   * ```
   */
  readonly spawn: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    SD extends SlotsDef = Record<string, never>,
  >(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, SD>,
    options?: {
      readonly supervision?: Supervision.Policy;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly slots?: ProvideSlots<SD, any>;
      readonly persist?: PersistConfig<S>;
    },
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
  SD extends SlotsDef,
>(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, SD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueueRef: Ref.Ref<Queue.Queue<QueuedEvent<E>>>,
  stoppedRef: Ref.Ref<boolean>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
  system: ActorSystem,
  childrenMap: ReadonlyMap<string, ActorRef<AnyState, unknown>>,
  pendingReplies: Set<Deferred.Deferred<unknown, unknown>>,
  transitionsPubSub: PubSub.PubSub<TransitionInfo<S, E>> | undefined,
  exitDeferred: Deferred.Deferred<ActorExit<S>, never>,
): ActorRef<S, E> => {
  const send = Effect.fn("effect-machine.actor.send")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (stopped) {
      return;
    }
    const q = yield* Ref.get(eventQueueRef);
    yield* Queue.offer(q, { _tag: "send", event });
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
    const q = yield* Ref.get(eventQueueRef);
    yield* Queue.offer(q, {
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
    const q = yield* Ref.get(eventQueueRef);
    yield* Queue.offer(q, {
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
    awaitExit: Deferred.await(exitDeferred),
    watch: (other) =>
      // Bind to the other actor's exitDeferred — authoritative, not system events.
      // Resolves with exit reason on terminal stop (ignores restarts in Step 3).
      other.awaitExit as Effect.Effect<ActorExit<unknown>>,
    drain: Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (stopped) return;
      const q = yield* Ref.get(eventQueueRef);
      const done = yield* Deferred.make<void, never>();
      yield* Queue.offer(q, { _tag: "drain" as const, done });
      yield* Deferred.await(done);
    }).pipe(Effect.asVoid) as Effect.Effect<void>,
    sync: {
      send: (event) => {
        const stopped = Effect.runSync(Ref.get(stoppedRef));
        if (!stopped) {
          const q = Effect.runSync(Ref.get(eventQueueRef));
          Effect.runSync(Queue.offer(q, { _tag: "send", event }));
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
 * Load persisted state and run onRestore hook if present.
 * Returns the resolved initial state (loaded, restored, or fallback to machineInitial).
 * @internal
 */
const loadAndRestore = <S extends { readonly _tag: string }>(
  persist: PersistConfig<S>,
  machineInitial: S,
): Effect.Effect<S> =>
  Effect.gen(function* () {
    const loaded = yield* persist.load();
    if (Option.isNone(loaded)) return machineInitial;
    if (persist.onRestore === undefined) return loaded.value;
    const restored = yield* persist.onRestore(loaded.value, { initial: machineInitial });
    return Option.getOrElse(restored, () => machineInitial);
  });

/**
 * Resolve actor system from context, creating an implicit one if none exists.
 * @internal
 */
const resolveActorSystem = Effect.fn("effect-machine.resolveActorSystem")(function* () {
  const existingSystem = yield* Effect.serviceOption(ActorSystem);
  if (Option.isSome(existingSystem)) {
    return { system: existingSystem.value, implicitSystemScope: undefined };
  }
  const scope = yield* Scope.make();
  const system = yield* make().pipe(Effect.provideService(Scope.Scope, scope));
  return { system, implicitSystemScope: scope as Scope.CloseableScope | undefined };
});

/**
 * Run the supervision loop for a supervised actor.
 * Observes exit deferred, applies restart policy, resets cell resources on restart.
 * @internal
 */
const runSupervisionLoop = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(params: {
  supervision: Supervision.Policy;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, any, any, any, any>;
  id: string;
  runtimeRef: { current: RuntimeHandle<S, E> | undefined };
  terminalExitDeferred: Deferred.Deferred<ActorExit<S>, never>;
  pendingReplies: Set<Deferred.Deferred<unknown, unknown>>;
  eventQueueRef: Ref.Ref<Queue.Queue<QueuedEvent<E>>>;
  stateRef: SubscriptionRef.SubscriptionRef<S>;
  stoppedRef: Ref.Ref<boolean>;
  childrenMap: Map<string, ActorRef<AnyState, unknown>>;
  listeners: Listeners<S>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawnGeneration: (m: any) => Effect.Effect<RuntimeHandle<S, E>>;
  persist?: PersistConfig<S>;
  onRestart?: (generation: number, exit: ActorExit<unknown>) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const driver = yield* Schedule.driver(params.supervision.schedule);
    let generation = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentRuntime = params.runtimeRef.current;
      if (currentRuntime === undefined) return;

      const generationExit = yield* Deferred.await(currentRuntime.exitDeferred);

      if (generationExit._tag !== "Defect") {
        yield* Deferred.succeed(params.terminalExitDeferred, generationExit);
        return;
      }

      if (
        params.supervision.shouldRestart !== undefined &&
        !params.supervision.shouldRestart(generationExit)
      ) {
        yield* Deferred.succeed(params.terminalExitDeferred, generationExit);
        return;
      }

      const scheduleExit = yield* driver.next(generationExit).pipe(Effect.exit);
      if (scheduleExit._tag === "Failure") {
        yield* Deferred.succeed(params.terminalExitDeferred, generationExit);
        return;
      }

      // Resolve restart state: persist.load()+onRestore > machine.initial
      const restartState =
        params.persist !== undefined
          ? yield* loadAndRestore(params.persist, params.machine.initial)
          : params.machine.initial;

      yield* settlePendingReplies(params.pendingReplies, params.id);
      const freshQueue = yield* Queue.unbounded<QueuedEvent<E>>();
      yield* Ref.set(params.eventQueueRef, freshQueue);
      yield* SubscriptionRef.set(params.stateRef, restartState);
      yield* Ref.set(params.stoppedRef, false);
      params.childrenMap.clear();

      const machineForRestart =
        restartState !== params.machine.initial
          ? (Object.create(params.machine, {
              initial: { value: restartState, enumerable: true },
            }) as typeof params.machine)
          : params.machine;
      const newRuntime = yield* params.spawnGeneration(machineForRestart);
      params.runtimeRef.current = newRuntime;
      generation++;

      if (params.onRestart !== undefined) {
        yield* params.onRestart(generation, generationExit);
      }

      notifyListeners(params.listeners, restartState);
    }
  });

/**
 * Create and start an actor for a machine.
 * Delegates to the shared runtime kernel with actor-specific lifecycle hooks.
 */
export const createActor = Effect.fn("effect-machine.actor.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  SD extends SlotsDef,
>(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any, SD>,
  options?: {
    initialState?: S;
    supervision?: Supervision.Policy;
    persist?: PersistConfig<S>;
    /** @internal Called by system after each restart — emits ActorRestarted system event */
    onRestart?: (generation: number, exit: ActorExit<unknown>) => Effect.Effect<void>;
  },
) {
  const persist = options?.persist;

  // Resolve initial state: hydrate > persist.load()+onRestore > machine.initial
  const initial: S =
    options?.initialState ??
    (persist !== undefined ? yield* loadAndRestore(persist, machine.initial) : machine.initial);
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", initial._tag);

  const { system, implicitSystemScope } = yield* resolveActorSystem();

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

  // Cell-owned resources: stable across generations (supervision)
  const stateRef = yield* SubscriptionRef.make<S>(initial);
  const stoppedRef = yield* Ref.make(false);
  const initialQueue = yield* Queue.unbounded<QueuedEvent<E>>();
  const eventQueueRef = yield* Ref.make(initialQueue);

  // Terminal exit deferred — set exactly once when the actor truly terminates.
  // This is what awaitExit/watch bind to, NOT the per-generation exitDeferred.
  const terminalExitDeferred = yield* Deferred.make<ActorExit<S>, never>();

  // Track whether @machine.stop has been emitted
  let stopEmitted = false;

  // Mutable ref for the current runtime — supervision loop updates this
  const runtimeRef: { current: RuntimeHandle<S, E> | undefined } = { current: undefined };

  /** Build lifecycle hooks for a generation */
  const buildLifecycle = (): RuntimeLifecycleHooks<S, E> => {
    stopEmitted = false;
    return {
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
          // Persist after state committed to ref, before reply settlement
          if (persist !== undefined && result.transitioned) {
            const shouldPersist =
              persist.shouldSave === undefined ||
              persist.shouldSave(result.newState, result.previousState);
            if (shouldPersist) {
              yield* persist.save(result.newState);
            }
          }
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
          if (!stopEmitted) {
            const finalState = yield* SubscriptionRef.get(stateRef);
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
    };
  };

  /** Create a single runtime generation. machineForGen is machineWithState for initial, machine for restarts. */
  const spawnGeneration = (machineForGen: typeof machine) =>
    Ref.get(eventQueueRef).pipe(
      Effect.flatMap(
        (currentQueue) =>
          createRuntime(machineForGen, system, {
            actorId: id,
            hooks,
            skipFinalizer: true,
            cellResources: { stateRef, stoppedRef, eventQueue: currentQueue },
            lifecycle: buildLifecycle(),
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
                    Effect.annotateCurrentSpan(
                      "effect_machine.transition.matched",
                      r.result.transitioned,
                    ),
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
          }) as Effect.Effect<RuntimeHandle<S, E>>,
      ),
    );

  // Spawn initial generation (with hydrated state if provided)
  const runtime = yield* spawnGeneration(machineWithState);
  runtimeRef.current = runtime;

  const supervision = options?.supervision;

  // Supervision loop or simple exit wiring
  let supervisorFiber: Fiber.Fiber<void, never> | undefined;
  if (supervision !== undefined) {
    supervisorFiber = yield* Effect.forkDaemon(
      runSupervisionLoop({
        supervision,
        machine,
        id,
        runtimeRef,
        terminalExitDeferred,
        pendingReplies,
        eventQueueRef,
        stateRef,
        stoppedRef,
        childrenMap,
        listeners,
        spawnGeneration,
        persist,
        onRestart: options?.onRestart,
      }),
    );
  } else {
    // No supervision — wire terminal exit from the single generation
    yield* Effect.forkDaemon(
      Deferred.await(runtime.exitDeferred).pipe(
        Effect.tap((exit) => Deferred.succeed(terminalExitDeferred, exit)),
      ),
    );
  }

  // Build actor stop — wraps current runtime.stop with implicit system teardown.
  // For supervised actors: interrupt supervisor fiber first (cancels restart/backoff),
  // then stop the current runtime, then set terminal exit.
  const stop = Effect.gen(function* () {
    // Interrupt supervisor loop first — prevents restart during/after stop
    if (supervisorFiber !== undefined) {
      yield* Fiber.interrupt(supervisorFiber);
    }
    const currentRuntime = runtimeRef.current;
    if (currentRuntime !== undefined) {
      yield* currentRuntime.stop;
    }
    // Set terminal exit (Deferred.succeed is idempotent — no-op if already set)
    yield* Deferred.succeed(terminalExitDeferred, { _tag: "Stopped" } as ActorExit<S>);
    if (implicitSystemScope !== undefined) {
      yield* Scope.close(implicitSystemScope, Exit.void);
    }
  }).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid);

  return buildActorRefCore(
    id,
    machine,
    stateRef,
    eventQueueRef,
    stoppedRef,
    listeners,
    stop,
    system,
    childrenMap,
    pendingReplies,
    transitionsPubSub,
    terminalExitDeferred,
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
      Effect.andThen(PubSub.publish(eventPubSub, event)),
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
            // Scope cleanup — use Stopped as the exit reason.
            // The authoritative exit is on actor.awaitExit, not here.
            yield* emitSystemEvent({
              _tag: "ActorStopped",
              id,
              actor: actorRef,
              exit: { _tag: "Stopped" } as ActorExit<unknown>,
            });
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
    machine: Machine<S, E, R, any, any, any>,
    spawnOptions?: {
      readonly supervision?: Supervision.Policy;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly slots?: Record<string, any>;
      readonly persist?: PersistConfig<S>;
    },
  ) {
    if (MutableHashMap.has(actorsMap, id)) {
      return yield* new DuplicateActorError({ actorId: id });
    }
    // Materialize slots if provided
    const materialized =
      spawnOptions?.slots !== undefined ? materializeMachine(machine, spawnOptions.slots) : machine;
    // Mutable ref for the actor — onRestart closure needs it, but actor isn't registered yet
    let actorRef: ActorRef<AnyState, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actor = yield* createActor(id, materialized as Machine<S, E, never, any, any, any>, {
      supervision: spawnOptions?.supervision,
      persist: spawnOptions?.persist,
      onRestart:
        spawnOptions?.supervision !== undefined
          ? (generation, exit) =>
              actorRef !== undefined
                ? emitSystemEvent({
                    _tag: "ActorRestarted",
                    id,
                    actor: actorRef,
                    generation,
                    exit,
                  })
                : Effect.void
          : undefined,
    });
    actorRef = actor as unknown as ActorRef<AnyState, unknown>;
    return yield* registerActor(id, actor);
  });

  const spawn = <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    SD extends SlotsDef = Record<string, never>,
  >(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, SD>,
    options?: {
      readonly supervision?: Supervision.Policy;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly slots?: ProvideSlots<SD, any>;
      readonly persist?: PersistConfig<S>;
    },
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
    yield* emitSystemEvent({
      _tag: "ActorStopped",
      id,
      actor,
      exit: { _tag: "Stopped" } as ActorExit<unknown>,
    });
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
export const Default = Layer.scoped(ActorSystem, make());
