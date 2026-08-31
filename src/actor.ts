/**
 * Actor system: spawning, lifecycle, and event processing.
 *
 * Combines:
 * - ActorRef interface (running actor handle)
 * - ActorSystem service (spawn/stop/get actors)
 * - Actor creation and event loop
 */
import {
  Deferred,
  Cause,
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
  Semaphore,
  Context,
  Stream,
  SubscriptionRef,
} from "effect";

import type { Machine, Lifecycle } from "./machine.js";
import { ActorExit, type Supervision } from "./supervision.js";
import type { ReplyTypeBrand, ExtractReply } from "./internal/brands.js";
import type { InspectorService } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import { resolveTransition, resolveTransitionEffect } from "./internal/transition.js";
import type { ProcessEventHooks, ProcessEventResult } from "./internal/transition.js";
import { emitWithTimestamp, makeInspectionHooks } from "./internal/inspection.js";
import type { NoReplyError } from "./errors.js";
import { DuplicateActorError, ActorStoppedError } from "./errors.js";
import {
  createRuntime,
  type RuntimeLifecycleHooks,
  type RuntimeQueuedEvent,
  type RuntimeHandle,
  type RuntimeExit,
} from "./internal/runtime.js";

export type { ProcessEventResult } from "./internal/transition.js";

// ============================================================================
// QueuedEvent — re-export from runtime kernel
// ============================================================================

/** Discriminated mailbox request — alias for RuntimeQueuedEvent */
type QueuedEvent<S, E> = RuntimeQueuedEvent<S, E>;

// ============================================================================
// ActorRef Interface
// ============================================================================

/** JavaScript client for code that does not run inside Effect. */
export interface ActorClient<State extends { readonly _tag: string }, Event, Output = State> {
  readonly send: (event: Event) => void;
  readonly stop: () => void;
  readonly getSnapshot: () => State;
  readonly matches: (tag: State["_tag"]) => boolean;
  readonly canSync: (event: Event) => boolean;
  readonly can: (event: Event) => Promise<boolean>;
  readonly getLifecycle: () => ActorLifecycle<State, Output>;
  readonly getLatestTransition: () => TransitionInfo<State, Event> | undefined;
  readonly subscribe: (listener: (state: State) => void) => () => void;
}

/** @deprecated Use `ActorClient`. */
export interface ActorRefSync<State extends { readonly _tag: string }, Event, Output = State> {
  readonly send: (event: Event) => void;
  readonly stop: () => void;
  readonly snapshot: () => State;
  readonly matches: (tag: State["_tag"]) => boolean;
  readonly can: (event: Event) => boolean;
  readonly lifecycle: () => ActorLifecycle<State, Output>;
  readonly latestTransition: () => TransitionInfo<State, Event> | undefined;
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

/** Observable actor lifecycle. Domain state remains available through `actor.state`. */
export type ActorLifecycle<State, Output = State> =
  | { readonly _tag: "Created" }
  | { readonly _tag: "Starting"; readonly generation: number }
  | { readonly _tag: "Active"; readonly generation: number }
  | ActorExit<State, Output>;

export interface ActorRef<State extends { readonly _tag: string }, Event, Output = State> {
  readonly id: string;

  /** Send an event (fire-and-forget). */
  readonly send: (event: Event) => Effect.Effect<void>;

  /**
   * Serialized request-reply (OTP gen_server:call).
   * Event is processed through the queue; caller gets ProcessEventResult back.
   */
  readonly call: (event: Event) => Effect.Effect<ProcessEventResult<State, Event>>;

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

  /** Observable actor lifecycle. */
  readonly lifecycle: SubscriptionRef.SubscriptionRef<ActorLifecycle<State, Output>>;

  /** The latest accepted edge. This value remains available after actor exit. */
  readonly latestTransition: SubscriptionRef.SubscriptionRef<
    TransitionInfo<State, Event> | undefined
  >;

  /** Stop the actor gracefully. */
  readonly stop: Effect.Effect<void>;

  /**
   * Start the actor — fork event loop, background effects, spawn effects.
   * Idempotent: first caller runs initialization, subsequent callers await completion.
   * Events sent before start() are queued and processed when start() runs.
   *
   * Called automatically by `system.spawn`. For `Machine.spawn`, the caller
   * must call `start` explicitly.
   */
  readonly start: Effect.Effect<void>;

  /** Get current state snapshot. */
  readonly snapshot: Effect.Effect<State>;

  /** Check if current state matches tag. */
  readonly matches: (tag: State["_tag"]) => Effect.Effect<boolean>;

  /** Check if an event has an enabled transition. Supports Boolean and Effect predicates. */
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

  /** Wait for the domain output of a final state. */
  readonly awaitOutput: Effect.Effect<Output, ActorStoppedError>;

  /** Send event and wait for predicate, state variant, or final state. */
  readonly sendAndWait: {
    (event: Event, predicate: (state: State) => boolean): Effect.Effect<State>;
    (event: Event, state: { readonly _tag: State["_tag"] }): Effect.Effect<State>;
    (event: Event): Effect.Effect<State>;
  };

  /** Subscribe to state changes (sync callback). Returns unsubscribe function. */
  readonly subscribe: (fn: (state: State) => void) => () => void;

  /** JavaScript client for callbacks and applications outside Effect. */
  readonly client: ActorClient<State, Event, Output>;

  /**
   * Wait for this actor's terminal exit. Resolves with the exit reason.
   * Set exactly once when the actor terminates (final, stop, drain, or defect).
   */
  readonly awaitExit: Effect.Effect<ActorExit<State, Output>>;

  /**
   * Drain: process all remaining events in the queue, then stop.
   * Unlike `stop` (which interrupts immediately), `drain` lets the actor finish its work.
   */
  readonly drain: Effect.Effect<void>;

  /** @deprecated Use `client`. */
  readonly sync: ActorRefSync<State, Event, Output>;

  /** The actor system this actor belongs to. */
  readonly system: ActorSystemService;

  /** Child actors spawned via `self.spawn` in this actor's handlers. */
  readonly children: ReadonlyMap<string, ActorRef<AnyState, unknown>>;
}

// ============================================================================
// ActorSystem Interface
// ============================================================================

/** Base type for stored actors (internal) */
type AnyState = { readonly _tag: string };

declare const ActorSystemKeyTypeId: unique symbol;

/** A typed identity for an actor stored in an ActorSystem. */
export class ActorSystemKey<State extends AnyState, Event, Output = State> {
  declare readonly [ActorSystemKeyTypeId]: {
    readonly state: State;
    readonly event: Event;
    readonly output: Output;
  };

  constructor(readonly id: string) {}
}

/** Create a typed ActorSystem identity. */
export const actorSystemKey = <State extends AnyState, Event, Output = State>(
  id: string,
): ActorSystemKey<State, Event, Output> => new ActorSystemKey(id);

type AnyActorSystemKey = ActorSystemKey<AnyState, unknown, unknown>;

const actorSystemId = (id: string | AnyActorSystemKey): string => {
  if (typeof id === "string") return id;
  return id.id;
};

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
export interface ActorSystemService {
  /**
   * Spawn a new actor with the given machine.
   *
   * @example
   * ```ts
   * const actor = yield* system.spawn("my-actor", machine);
   * ```
   */
  readonly spawn: {
    <S extends AnyState, E extends { readonly _tag: string }, R, Output>(
      key: ActorSystemKey<S, E, Output>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      machine: Machine<S, E, R, any, any, void, Output>,
      options?: SystemSpawnOptions<S, E, void>,
    ): Effect.Effect<ActorRef<S, E, Output>, DuplicateActorError, R>;
    <S extends AnyState, E extends { readonly _tag: string }, R, Output>(
      id: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      machine: Machine<S, E, R, any, any, void, Output>,
      options?: SystemSpawnOptions<S, E, void>,
    ): Effect.Effect<ActorRef<S, E, Output>, DuplicateActorError, R>;
    <S extends AnyState, E extends { readonly _tag: string }, R, Input, Output>(
      key: ActorSystemKey<S, E, Output>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      machine: Machine<S, E, R, any, any, Input, Output>,
      options: SystemSpawnOptions<S, E, Input>,
    ): Effect.Effect<ActorRef<S, E, Output>, DuplicateActorError, R>;
    <S extends AnyState, E extends { readonly _tag: string }, R, Input, Output>(
      id: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      machine: Machine<S, E, R, any, any, Input, Output>,
      options: SystemSpawnOptions<S, E, Input>,
    ): Effect.Effect<ActorRef<S, E, Output>, DuplicateActorError, R>;
  };

  /**
   * Get an existing actor by ID
   */
  readonly get: {
    <S extends AnyState, E, Output>(
      key: ActorSystemKey<S, E, Output>,
    ): Effect.Effect<Option.Option<ActorRef<S, E, Output>>>;
    (id: string): Effect.Effect<Option.Option<ActorRef<AnyState, unknown>>>;
  };

  /** Observe the current actor for one ID across actor generations. */
  readonly watch: {
    <S extends AnyState, E, Output>(
      key: ActorSystemKey<S, E, Output>,
    ): Stream.Stream<Option.Option<ActorRef<S, E, Output>>>;
    (id: string): Stream.Stream<Option.Option<ActorRef<AnyState, unknown>>>;
  };

  /**
   * Stop an actor by ID
   */
  readonly stop: (id: string | AnyActorSystemKey) => Effect.Effect<boolean>;

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

export type SystemSpawnOptions<S, E, Input> = {
  readonly supervision?: Supervision.Policy;
  readonly lifecycle?: Lifecycle<S, E>;
  readonly hydrate?: S;
} & ([Input] extends [void] ? { readonly input?: never } : { readonly input: Input });

/**
 * ActorSystem service tag
 */
export class ActorSystem extends Context.Service<ActorSystem, ActorSystemService>()(
  "effect-machine/actor/ActorSystem",
) {}

/**
 * Explicit scope for actor lifecycle management.
 *
 * When present in context, actors attach cleanup finalizers to this scope.
 * This replaces ambient `Scope.Scope` detection which caused bugs where
 * unrelated scopes would tear down actors unexpectedly.
 *
 * Provide via `Machine.scoped` or `Effect.provideService(ActorScope, scope)`.
 */
export class ActorScope extends Context.Service<ActorScope, Scope.Scope>()(
  "effect-machine/actor/ActorScope",
) {}

// ============================================================================
// Actor Core Helpers
// ============================================================================

/** Listener set for sync subscriptions */
type Listeners<S> = Set<(state: S) => void>;

/**
 * Notify all listeners of state change.
 */
const notifyListeners = <S>(listeners: Listeners<S>, state: S): void => {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // Ignore listener failures to avoid crashing the actor loop
    }
  }
};

const toActorExit = <S, O>(
  machine: { readonly _output: (state: S) => O },
  exit: RuntimeExit<S>,
): ActorExit<S, O> => {
  if (exit._tag === "Final") return ActorExit.Final(exit.state, machine._output(exit.state));
  if (exit._tag === "Defect") {
    return { _tag: "Defect", cause: exit.cause, phase: exit.phase };
  }
  return { _tag: "Stopped" };
};

/** Resources that belong to one Actor cell and survive runtime generations. */
interface ActorCell<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  O,
> {
  readonly id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  readonly machine: Machine<S, E, R, any, any, any, O>;
  readonly machineInitial: S;
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  readonly stoppedRef: Ref.Ref<boolean>;
  readonly eventQueueRef: Ref.Ref<Queue.Queue<QueuedEvent<S, E>>>;
  readonly runtimeRef: { current: RuntimeHandle<S, E> | undefined };
  readonly terminalExitDeferred: Deferred.Deferred<ActorExit<S, O>>;
  readonly listeners: Listeners<S>;
  readonly children: Map<string, ActorRef<AnyState, unknown>>;
  readonly transitions: PubSub.PubSub<TransitionInfo<S, E>>;
  readonly lifecycleRef: SubscriptionRef.SubscriptionRef<ActorLifecycle<S, O>>;
  readonly latestTransitionRef: SubscriptionRef.SubscriptionRef<TransitionInfo<S, E> | undefined>;
  readonly system: ActorSystemService;
  readonly generation: { current: number };
}

/**
 * Build core ActorRef methods.
 */
const buildActorRefCore = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  O,
>(
  cell: ActorCell<S, E, R, O>,
  stop: Effect.Effect<void>,
  start: Effect.Effect<void>,
  serviceContext: Context.Context<R>,
): ActorRef<S, E, O> => {
  const {
    id,
    machine,
    stateRef,
    runtimeRef,
    listeners,
    system,
    lifecycleRef,
    latestTransitionRef,
  } = cell;
  const send = (event: E) =>
    Effect.gen(function* () {
      const runtime = runtimeRef.current;
      if (runtime !== undefined) yield* runtime.send(event);
    });

  const stoppedCall = (event: E) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("effect-machine.actor.call.stopped").pipe(
        Effect.annotateLogs({ actorId: id, eventTag: event._tag }),
      );
      const currentState = yield* SubscriptionRef.get(stateRef);
      return {
        newState: currentState,
        previousState: currentState,
        transitioned: false,
        hasReply: false,
        deferReply: false,
        reply: undefined,
        postponed: false,
        lifecycleRan: false,
        isFinal: machine._isFinal(currentState._tag),
        transitions: [],
      } satisfies ProcessEventResult<S, E>;
    });

  const call = (event: E) =>
    Effect.suspend(() => {
      const runtime = runtimeRef.current;
      if (runtime === undefined) return stoppedCall(event);
      return runtime.call(event).pipe(Effect.catch(() => stoppedCall(event)));
    });

  const ask = Effect.fn("effect-machine.actor.ask")(function* (event: E) {
    const runtime = runtimeRef.current;
    if (runtime === undefined) return yield* ActorStoppedError.make({ actorId: id });
    return yield* runtime.ask(event);
  });

  const snapshot = SubscriptionRef.get(stateRef).pipe(
    Effect.withSpan("effect-machine.actor.snapshot"),
  );

  const matches = Effect.fn("effect-machine.actor.matches")(function* (tag: S["_tag"]) {
    const state = yield* SubscriptionRef.get(stateRef);
    return state._tag === tag;
  });

  const canEffect = Effect.fn("effect-machine.actor.can")(function* (event: E) {
    const state = yield* SubscriptionRef.get(stateRef);
    return (yield* resolveTransitionEffect(machine, state, event)) !== undefined;
  });
  const can = (event: E) => canEffect(event).pipe(Effect.provide(serviceContext));

  const waitFor = Effect.fn("effect-machine.actor.waitFor")(function* (
    predicateOrState: ((state: S) => boolean) | { readonly _tag: S["_tag"] },
  ) {
    let predicate: (state: S) => boolean;
    if (typeof predicateOrState === "function" && !("_tag" in predicateOrState)) {
      predicate = predicateOrState;
    } else {
      predicate = (s: S) => s._tag === (predicateOrState as { readonly _tag: string })._tag;
    }

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

  const awaitFinal = waitFor((state) => machine._isFinal(state._tag)).pipe(
    Effect.withSpan("effect-machine.actor.awaitFinal"),
  );

  const awaitOutput = Deferred.await(cell.terminalExitDeferred).pipe(
    Effect.flatMap((exit) => {
      if (exit._tag === "Final") return Effect.succeed(exit.output);
      if (exit._tag === "Defect") return Effect.die(Cause.squash(exit.cause));
      return ActorStoppedError.make({ actorId: id });
    }),
    Effect.withSpan("effect-machine.actor.awaitOutput"),
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

  const transitions = Stream.fromPubSub(cell.transitions);
  const subscribe = (listener: (state: S) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const sendClient = (event: E): void => {
    runtimeRef.current?.sendSync(event);
  };
  const stopClient = (): void => {
    Effect.runFork(stop);
  };
  const getSnapshot = (): S => Effect.runSync(SubscriptionRef.get(stateRef));
  const matchesClient = (tag: S["_tag"]): boolean => getSnapshot()._tag === tag;
  const canSync = (event: E): boolean =>
    resolveTransition(machine, getSnapshot(), event) !== undefined;
  const getLifecycle = (): ActorLifecycle<S, O> =>
    Effect.runSync(SubscriptionRef.get(lifecycleRef));
  const getLatestTransition = (): TransitionInfo<S, E> | undefined =>
    Effect.runSync(SubscriptionRef.get(latestTransitionRef));
  const client: ActorClient<S, E, O> = {
    send: sendClient,
    stop: stopClient,
    getSnapshot,
    matches: matchesClient,
    canSync,
    can: (event) => Effect.runPromise(can(event)),
    getLifecycle,
    getLatestTransition,
    subscribe,
  };

  return {
    id,
    send,
    call,
    ask: ask as ActorRef<S, E, O>["ask"],
    state: stateRef,
    lifecycle: lifecycleRef,
    latestTransition: latestTransitionRef,
    stop,
    start,
    snapshot,
    matches,
    can,
    changes: SubscriptionRef.changes(stateRef),
    transitions,
    waitFor,
    awaitFinal,
    awaitOutput,
    sendAndWait,
    subscribe,
    client,
    awaitExit: Deferred.await(cell.terminalExitDeferred),
    drain: Effect.suspend(() => runtimeRef.current?.drain ?? Effect.void),
    sync: {
      send: sendClient,
      stop: stopClient,
      snapshot: getSnapshot,
      matches: matchesClient,
      can: canSync,
      lifecycle: getLifecycle,
      latestTransition: getLatestTransition,
    },
    system,
    children: cell.children,
  };
};

// ============================================================================
// Actor Creation — delegates to runtime kernel with actor-specific hooks
// ============================================================================

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
  return { system, implicitSystemScope: scope as Scope.Closeable | undefined };
});

/**
 * Run the supervision loop for a supervised actor.
 * Observes exit deferred, applies restart policy, resets cell resources on restart.
 * @internal
 */
const runSupervisionLoop = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  O,
>(
  cell: ActorCell<S, E, R, O>,
  options: {
    supervision: Supervision.Policy;
    spawnGeneration: (
      machine: ActorCell<S, E, R, O>["machine"],
    ) => Effect.Effect<RuntimeHandle<S, E>>;
    lifecycle?: Lifecycle<S, E>;
    onRestart?: (generation: number, exit: ActorExit<unknown>) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStepWithSleep(options.supervision.schedule);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const currentRuntime = cell.runtimeRef.current;
      if (currentRuntime === undefined) return;

      const generationExit = yield* Deferred.await(currentRuntime.exitDeferred);

      if (generationExit._tag !== "Defect") {
        yield* Deferred.succeed(
          cell.terminalExitDeferred,
          toActorExit(cell.machine, generationExit),
        );
        return;
      }

      if (
        options.supervision.shouldRestart !== undefined &&
        !options.supervision.shouldRestart(generationExit)
      ) {
        yield* Deferred.succeed(cell.terminalExitDeferred, generationExit);
        return;
      }

      const pull = step(generationExit);
      const scheduleExit = yield* pull.pipe(Effect.exit);
      if (scheduleExit._tag === "Failure") {
        yield* Deferred.succeed(cell.terminalExitDeferred, generationExit);
        return;
      }

      // Bump generation before restart — recovery.resolve sees the new generation
      const nextGeneration = cell.generation.current + 1;
      cell.generation.current = nextGeneration;

      // Resolve restart state via recovery or fall back to the original machine input.
      // Recovery runs here (not in runtime.start) for supervision restarts
      // because the cell resources need the resolved state before runtime creation.
      let restartState = cell.machineInitial;
      if (options.lifecycle?.recovery !== undefined) {
        const resolved = yield* options.lifecycle.recovery.resolve({
          actorId: cell.id,
          generation: nextGeneration,
          machineInitial: cell.machineInitial,
        });
        if (Option.isSome(resolved)) {
          restartState = resolved.value;
        }
      }

      yield* currentRuntime.settlePendingRequests;
      yield* SubscriptionRef.set(cell.lifecycleRef, {
        _tag: "Starting",
        generation: nextGeneration,
      });
      const freshQueue = yield* Queue.unbounded<QueuedEvent<S, E>>();
      yield* Ref.set(cell.eventQueueRef, freshQueue);
      yield* SubscriptionRef.set(cell.stateRef, restartState);
      yield* SubscriptionRef.set(cell.latestTransitionRef, undefined);
      yield* Ref.set(cell.stoppedRef, false);
      cell.children.clear();

      const newRuntime = yield* options.spawnGeneration(cell.machine);
      cell.runtimeRef.current = newRuntime;
      yield* newRuntime.start;
      const restartExit = yield* Deferred.poll(newRuntime.exitDeferred);
      if (Option.isNone(restartExit)) {
        yield* SubscriptionRef.set(cell.lifecycleRef, {
          _tag: "Active",
          generation: nextGeneration,
        });
      }

      if (options.onRestart !== undefined) {
        yield* options.onRestart(nextGeneration, generationExit);
      }

      notifyListeners(cell.listeners, restartState);
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
  O,
>(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any, any, O>,
  options: {
    initialState: S;
    machineInitial: S;
    hydrated?: boolean;
    supervision?: Supervision.Policy;
    lifecycle?: Lifecycle<S, E>;
    /** @internal Called by system after each restart — emits ActorRestarted system event */
    onRestart?: (generation: number, exit: ActorExit<unknown>) => Effect.Effect<void>;
  },
) {
  const lifecycle: Lifecycle<S, E> | undefined = options.lifecycle;
  const serviceContext = yield* Effect.context<R>();

  // Spawn is cold. The caller has already resolved machine input and hydration.
  // Recovery runs during start, not allocate.
  const initial = options.initialState;
  yield* Effect.annotateCurrentSpan("effect_machine.actor.id", id);
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", initial._tag);

  const { system, implicitSystemScope } = yield* resolveActorSystem();

  // Get optional inspector from context
  const inspectorValue = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
    | InspectorService<S, E>
    | undefined;

  // Actor-specific state
  const childrenMap = new Map<string, ActorRef<AnyState, unknown>>();
  const listeners: Listeners<S> = new Set();
  const transitionsPubSub = yield* PubSub.unbounded<TransitionInfo<S, E>>();

  // Generation counter. Recovery and inspection use the same value.
  const generation = { current: 0 };

  const inspectionHooks = (runtimeGeneration: number): ProcessEventHooks<S, E> | undefined => {
    if (inspectorValue === undefined) return undefined;
    return makeInspectionHooks(id, inspectorValue, () => runtimeGeneration);
  };

  // Cell-owned resources: stable across generations (supervision)
  const stateRef = yield* SubscriptionRef.make<S>(initial);
  const lifecycleRef = yield* SubscriptionRef.make<ActorLifecycle<S, O>>({ _tag: "Created" });
  const latestTransitionRef = yield* SubscriptionRef.make<TransitionInfo<S, E> | undefined>(
    undefined,
  );
  const stoppedRef = yield* Ref.make(false);
  const initialQueue = yield* Queue.unbounded<QueuedEvent<S, E>>();
  const eventQueueRef = yield* Ref.make(initialQueue);

  // Terminal exit deferred — set exactly once when the actor truly terminates.
  // This is what awaitExit/watch bind to, NOT the per-generation exitDeferred.
  const terminalExitDeferred = yield* Deferred.make<ActorExit<S, O>>();

  // Mutable ref for the current runtime — supervision loop updates this
  const runtimeRef: { current: RuntimeHandle<S, E> | undefined } = { current: undefined };

  // Mutable ref for supervisor fiber — set during start, used by stop
  const supervisorFiberRef: { current: Fiber.Fiber<void> | undefined } = {
    current: undefined,
  };

  const cell: ActorCell<S, E, R, O> = {
    id,
    machine,
    machineInitial: options.machineInitial,
    stateRef,
    stoppedRef,
    eventQueueRef,
    runtimeRef,
    terminalExitDeferred,
    listeners,
    children: childrenMap,
    transitions: transitionsPubSub,
    lifecycleRef,
    latestTransitionRef,
    system,
    generation,
  };

  /** Build lifecycle hooks for a generation */
  const buildRuntimeLifecycle = (runtimeGeneration: number): RuntimeLifecycleHooks<S, E> => {
    let stopEmitted = false;
    let onEvent: RuntimeLifecycleHooks<S, E>["onEvent"] = undefined;
    if (inspectorValue !== undefined) {
      onEvent = (state: S, event: E) =>
        emitWithTimestamp(inspectorValue, (timestamp) => ({
          type: "@machine.event",
          actorId: id,
          generation: runtimeGeneration,
          state,
          event,
          timestamp,
        }));
    }
    let onFinal: RuntimeLifecycleHooks<S, E>["onFinal"] = undefined;
    if (inspectorValue !== undefined) {
      onFinal = (state: S) =>
        Effect.gen(function* () {
          stopEmitted = true;
          yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
            type: "@machine.stop",
            actorId: id,
            generation: runtimeGeneration,
            finalState: state,
            timestamp,
          }));
        });
    }
    let onInitialSpawnEffects: RuntimeLifecycleHooks<S, E>["onInitialSpawnEffects"] = undefined;
    if (inspectorValue !== undefined) {
      onInitialSpawnEffects = (state: S) =>
        emitWithTimestamp(inspectorValue, (timestamp) => ({
          type: "@machine.effect",
          actorId: id,
          generation: runtimeGeneration,
          effectType: "spawn",
          state,
          timestamp,
        }));
    }
    return {
      onEvent,
      onStateChange: (result, event) =>
        Effect.gen(function* () {
          notifyListeners(listeners, result.newState);
          const durability = lifecycle?.durability;
          if (durability === undefined || !result.transitioned) return;
          const shouldPersist =
            durability.shouldSave === undefined ||
            durability.shouldSave(result.newState, result.previousState);
          if (!shouldPersist) return;
          yield* durability.save({
            actorId: id,
            generation: runtimeGeneration,
            previousState: result.previousState,
            nextState: result.newState,
            event,
          });
        }),
      onProcessed: (result, _event) => {
        if (!result.transitioned || transitionsPubSub.subscribers.size === 0) return;
        return Effect.forEach(
          result.transitions,
          (transition) =>
            PubSub.publish(transitionsPubSub, {
              fromState: transition.previousState,
              toState: transition.newState,
              event: transition.event,
            }),
          { discard: true },
        );
      },
      onFinal,
      onShutdown: () =>
        Effect.gen(function* () {
          if (!stopEmitted) {
            const finalState = yield* SubscriptionRef.get(stateRef);
            yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
              type: "@machine.stop",
              actorId: id,
              generation: runtimeGeneration,
              finalState,
              timestamp,
            }));
          }
        }),
      onInitialSpawnEffects,
    };
  };

  /** Create a single runtime generation. machineForGen is machineWithState for initial, machine for restarts. */
  const spawnGeneration = (machineForGen: typeof machine) => {
    const runtimeGeneration = generation.current;
    return Ref.get(eventQueueRef).pipe(
      Effect.flatMap(
        (currentQueue) =>
          createRuntime(machineForGen, system, {
            actorId: id,
            generation: runtimeGeneration,
            hooks: inspectionHooks(runtimeGeneration),
            skipFinalizer: true,
            cellResources: {
              stateRef,
              latestTransitionRef,
              stoppedRef,
              eventQueue: currentQueue,
            },
            lifecycle: buildRuntimeLifecycle(runtimeGeneration),
            onChildSpawned: (childId, child) =>
              Effect.gen(function* () {
                childrenMap.set(childId, child as unknown as ActorRef<AnyState, unknown>);
                // Use Scope.Scope here intentionally — this is the spawn handler's
                // state-scoped scope, not an ambient scope. When the state exits,
                // this scope closes and the child is removed from the map.
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
  };

  // Spawn initial generation (with hydrated state if provided)
  const runtime = yield* spawnGeneration(machine);
  runtimeRef.current = runtime;

  const supervision = options.supervision;

  // Build actor stop — wraps current runtime.stop with implicit system teardown.
  // For supervised actors: interrupt supervisor fiber first (cancels restart/backoff),
  // then stop the current runtime, then set terminal exit.
  const stopActor = Effect.fn("effect-machine.actor.stop")(function* () {
    // Interrupt supervisor loop first — prevents restart during/after stop
    if (supervisorFiberRef.current !== undefined) {
      yield* Fiber.interrupt(supervisorFiberRef.current);
    }
    const currentRuntime = runtimeRef.current;
    if (currentRuntime !== undefined) {
      yield* currentRuntime.stop;
    }
    // Set terminal exit (Deferred.succeed is idempotent — no-op if already set)
    yield* Deferred.succeed(terminalExitDeferred, ActorExit.Stopped);
    if (implicitSystemScope !== undefined) {
      yield* Scope.close(implicitSystemScope, Exit.void);
    }
  });
  const stop = stopActor().pipe(Effect.provide(serviceContext), Effect.asVoid);

  // Track whether hydrate was provided — skip recovery when hydrated
  const isHydrated = options.hydrated === true;

  // Build actor start — runs recovery, emits @machine.spawn, arms supervisor, then delegates to runtime.start
  const startActor = Effect.fn("effect-machine.actor.start")(function* () {
    yield* SubscriptionRef.set(lifecycleRef, {
      _tag: "Starting",
      generation: generation.current,
    });
    // Run recovery if lifecycle.recovery exists AND not hydrated (hydrate takes precedence)
    if (lifecycle?.recovery !== undefined && !isHydrated) {
      const resolved = yield* lifecycle.recovery.resolve({
        actorId: id,
        generation: generation.current,
        machineInitial: options.machineInitial,
      });
      if (Option.isSome(resolved)) {
        // Update cell stateRef
        yield* SubscriptionRef.set(stateRef, resolved.value);
        // Recreate the runtime against the recovered cell state.
        const newRuntime = yield* spawnGeneration(machine);
        runtimeRef.current = newRuntime;
      }
    }

    // Emit @machine.spawn inspection event (moved from allocate → start)
    const currentState = yield* SubscriptionRef.get(stateRef);
    yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
      type: "@machine.spawn",
      actorId: id,
      generation: generation.current,
      initialState: currentState,
      timestamp,
    }));

    // Arm supervisor (moved from allocate → start)
    if (supervision !== undefined) {
      supervisorFiberRef.current = yield* Effect.forkDetach(
        runSupervisionLoop(cell, {
          supervision,
          spawnGeneration,
          lifecycle,
          onRestart: options.onRestart,
        }),
      );
    } else {
      // No supervision — wire terminal exit from the current generation
      const currentRuntime = runtimeRef.current;
      if (currentRuntime !== undefined) {
        yield* Effect.forkDetach(
          Deferred.await(currentRuntime.exitDeferred).pipe(
            Effect.tap((exit) =>
              Deferred.succeed(terminalExitDeferred, toActorExit(machine, exit)),
            ),
          ),
        );
      }
    }

    // Delegate to runtime.start (forks event loop, background, spawn effects)
    const currentRuntime = runtimeRef.current;
    if (currentRuntime !== undefined) {
      yield* currentRuntime.start;
      const currentExit = yield* Deferred.poll(currentRuntime.exitDeferred);
      if (Option.isNone(currentExit)) {
        yield* SubscriptionRef.set(lifecycleRef, {
          _tag: "Active",
          generation: generation.current,
        });
      }
    }
  });
  const start = startActor().pipe(Effect.provide(serviceContext), Effect.asVoid);

  yield* Effect.forkDetach(
    Deferred.await(terminalExitDeferred).pipe(
      Effect.flatMap((exit) => SubscriptionRef.set(lifecycleRef, exit)),
      Effect.provide(serviceContext),
    ),
  );

  return buildActorRefCore(cell, stop, start, serviceContext);
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
    return Effect.all(stops).pipe(Effect.andThen(PubSub.shutdown(eventPubSub)), Effect.asVoid);
  });

  /** Check for duplicate ID, register actor, attach scope cleanup if available */
  const registerActor = Effect.fn("effect-machine.actorSystem.register")(function* <
    T extends { stop: Effect.Effect<void> },
  >(id: string, actor: T) {
    // Check if actor already exists
    if (MutableHashMap.has(actorsMap, id)) {
      // Stop the newly created actor to avoid leaks
      yield* actor.stop;
      return yield* DuplicateActorError.make({ actorId: id });
    }

    const actorRef = actor as unknown as ActorRef<AnyState, unknown>;

    // Register it - O(1)
    MutableHashMap.set(actorsMap, id, actorRef);

    // Emit spawned event
    yield* emitSystemEvent({ _tag: "ActorSpawned", id, actor: actorRef });

    // Remove terminal actors. Keep supervised actors registered across restarts.
    yield* Effect.forkDetach(
      actorRef.awaitExit.pipe(
        Effect.flatMap((exit) => {
          const registered = MutableHashMap.get(actorsMap, id);
          if (Option.isNone(registered) || registered.value !== actorRef) return Effect.void;
          MutableHashMap.remove(actorsMap, id);
          return emitSystemEvent({ _tag: "ActorStopped", id, actor: actorRef, exit });
        }),
      ),
    );

    // If ActorScope available, attach per-actor cleanup
    const maybeScope = yield* Effect.serviceOption(ActorScope);
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
    Input,
    Output,
  >(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, Input, Output>,
    spawnOptions: SystemSpawnOptions<S, E, Input> | undefined,
  ) {
    if (MutableHashMap.has(actorsMap, id)) {
      return yield* DuplicateActorError.make({ actorId: id });
    }
    // Mutable ref for the actor �� onRestart closure needs it, but actor isn't registered yet
    let actorRef: ActorRef<AnyState, unknown> | undefined;
    let onRestart:
      | ((generation: number, exit: ActorExit<unknown>) => Effect.Effect<void>)
      | undefined = undefined;
    if (spawnOptions?.supervision !== undefined) {
      onRestart = (generation, exit) => {
        const currentActor = actorRef;
        if (currentActor === undefined) return Effect.void;
        return emitSystemEvent({
          _tag: "ActorRestarted",
          id,
          actor: currentActor,
          generation,
          exit,
        });
      };
    }
    const machineInitial = machine._initial(spawnOptions?.input);
    const initialState = spawnOptions?.hydrate ?? machineInitial;
    const actor = yield* createActor(id, machine, {
      initialState,
      machineInitial,
      hydrated: spawnOptions?.hydrate !== undefined,
      supervision: spawnOptions?.supervision,
      lifecycle: spawnOptions?.lifecycle,
      onRestart,
    });
    actorRef = actor as unknown as ActorRef<AnyState, unknown>;
    // Register before start — actor is in the map before lifecycle hooks fire
    yield* registerActor(id, actor);
    // Auto-start: system.spawn returns a running actor
    yield* actor.start.pipe(
      Effect.catchCause((cause) => actor.stop.pipe(Effect.andThen(Effect.failCause(cause)))),
    );
    return actor;
  });

  const spawn = <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    Input,
    Output,
  >(
    idOrKey: string | ActorSystemKey<S, E, Output>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, Input, Output>,
    options?: SystemSpawnOptions<S, E, Input>,
  ): Effect.Effect<ActorRef<S, E, Output>, DuplicateActorError, R> => {
    const id = actorSystemId(idOrKey);
    return withSpawnGate(spawnRegular(id, machine, options)) as Effect.Effect<
      ActorRef<S, E, Output>,
      DuplicateActorError,
      R
    >;
  };

  function get<S extends AnyState, E, Output>(
    key: ActorSystemKey<S, E, Output>,
  ): Effect.Effect<Option.Option<ActorRef<S, E, Output>>>;
  function get(id: string): Effect.Effect<Option.Option<ActorRef<AnyState, unknown>>>;
  function get(idOrKey: string | AnyActorSystemKey): Effect.Effect<Option.Option<unknown>> {
    return Effect.sync(() => MutableHashMap.get(actorsMap, actorSystemId(idOrKey)));
  }

  const sameActor = (left: Option.Option<unknown>, right: Option.Option<unknown>): boolean => {
    if (Option.isNone(left)) return Option.isNone(right);
    return Option.isSome(right) && Object.is(left.value, right.value);
  };

  function watch<S extends AnyState, E, Output>(
    key: ActorSystemKey<S, E, Output>,
  ): Stream.Stream<Option.Option<ActorRef<S, E, Output>>>;
  function watch(id: string): Stream.Stream<Option.Option<ActorRef<AnyState, unknown>>>;
  function watch(idOrKey: string | AnyActorSystemKey): Stream.Stream<Option.Option<unknown>> {
    const id = actorSystemId(idOrKey);
    return Stream.callback<Option.Option<unknown>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const unsubscribe = (event: SystemEvent): void => {
            if (event.id !== id) return;
            if (event._tag === "ActorSpawned") {
              Queue.offerUnsafe(queue, Option.some(event.actor));
            } else if (event._tag === "ActorStopped") {
              Queue.offerUnsafe(queue, Option.none());
            }
          };
          eventListeners.add(unsubscribe);
          Queue.offerUnsafe(queue, MutableHashMap.get(actorsMap, id));
          return (): void => {
            eventListeners.delete(unsubscribe);
          };
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ),
    ).pipe(Stream.changesWith(sameActor));
  }

  const stop = Effect.fn("effect-machine.actorSystem.stop")(function* (
    idOrKey: string | AnyActorSystemKey,
  ) {
    const id = actorSystemId(idOrKey);
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
    watch,
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
