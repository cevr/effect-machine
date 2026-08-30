// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * Shared runtime kernel for machine event processing.
 *
 * Provides a single-queue event loop with:
 * - Sequential event processing (no split-mailbox race)
 * - Postpone buffer with drain-on-state-change (gen_statem)
 * - Background effect lifecycle (under actorScope fault boundary)
 * - Spawn effect lifecycle (per-state scope)
 * - Final state detection → stop
 * - Reply settlement (call/ask Deferreds)
 * - Reply schema validation
 * - Lifecycle hooks for actor-specific concerns (inspection, listeners, etc.)
 * - ActorExit with exit reason (Final/Stopped/Defect) via exitDeferred
 *
 * Used by entity-machine and local actor (actor.ts delegates here).
 *
 * @internal
 */
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Queue,
  Ref,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect";

import type { Machine, MachineRef } from "../machine.js";
import type { ActorRef, ActorSystemService } from "../actor.js";
import { ActorSystem as ActorSystemTag } from "../actor.js";
import type { ProcessEventHooks, ProcessEventResult } from "./transition.js";
import { processEventCoreImmediate, runSpawnEffects, shouldPostpone } from "./transition.js";
import { makeEventAdvancement } from "./event-advancement.js";
import { ActorStoppedError, NoReplyError } from "../errors.js";
import { INTERNAL_INIT_EVENT, isEffect } from "./utils.js";
import { ActorExit, type DefectPhase } from "../supervision.js";

// ============================================================================
// QueuedEvent — unified type for all event loop consumers
// ============================================================================

/** @internal */
export type RuntimeQueuedEvent<S, E> =
  | { readonly _tag: "send"; readonly event: E }
  | {
      readonly _tag: "sendWait";
      readonly event: E;
      readonly done: Deferred.Deferred<void, unknown>;
    }
  | {
      readonly _tag: "call";
      readonly event: E;
      readonly reply: Deferred.Deferred<ProcessEventResult<S, E>, ActorStoppedError>;
    }
  | {
      readonly _tag: "ask";
      readonly event: E;
      readonly reply: Deferred.Deferred<unknown, NoReplyError | ActorStoppedError>;
    }
  | {
      readonly _tag: "drain";
      readonly done: Deferred.Deferred<void>;
    };

// ============================================================================
// Cell resources — stable across runtime generations
// ============================================================================

/**
 * Resources owned by the actor or entity cell.
 * Their identity stays stable for the runtime lifetime.
 * @internal
 */
export interface RuntimeCellResources<S, E> {
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  readonly eventQueue: Queue.Queue<RuntimeQueuedEvent<S, E>>;
  readonly stoppedRef: Ref.Ref<boolean>;
}

// ============================================================================
// Runtime interface
// ============================================================================

/** @internal */
export interface RuntimeHandle<S, E> {
  /** Enqueue a fire-and-forget event */
  readonly send: (event: E) => Effect.Effect<void>;
  /** Enqueue event and wait for processing to complete (for RPC Send). Fails on defect. */
  readonly sendWait: (event: E) => Effect.Effect<void, unknown>;
  /** Enqueue an event and return its processing result. */
  readonly call: (event: E) => Effect.Effect<ProcessEventResult<S, E>, ActorStoppedError>;
  /** Enqueue an ask event, returns the reply value */
  readonly ask: (event: E) => Effect.Effect<unknown, NoReplyError | ActorStoppedError>;
  /** Process queued events and stop. */
  readonly drain: Effect.Effect<void>;
  /** Enqueue an event from a synchronous adapter. */
  readonly sendSync: (event: E) => void;
  /** Get current state */
  readonly getState: Effect.Effect<S>;
  /** SubscriptionRef for state observation (WatchState streaming) */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  /** Stop the runtime (interrupt event loop, clean up) */
  readonly stop: Effect.Effect<void>;
  /**
   * Start the runtime — fork event loop, background effects, spawn effects.
   * Idempotent: first caller runs initialization, subsequent callers await completion.
   * Events sent before start() are queued and processed when start() runs.
   */
  readonly start: Effect.Effect<void>;
  /** Fail pending requests for this runtime generation. */
  readonly settlePendingRequests: Effect.Effect<void>;
  /**
   * Exit deferred — set exactly once with the exit reason when the runtime stops.
   * Final state → ActorExit.Final, explicit stop → ActorExit.Stopped, defect → ActorExit.Defect.
   */
  readonly exitDeferred: Deferred.Deferred<ActorExit<S>>;
}

// ============================================================================
// Lifecycle hooks — actor-specific concerns injected into the kernel
// ============================================================================

/** @internal */
export interface RuntimeLifecycleHooks<S, E> {
  /** Before processEventCore — actor emits @machine.event inspection */
  readonly onEvent?: (state: S, event: E) => Effect.Effect<void>;
  /** After SubscriptionRef.set on transition — actor notifies listeners and saves durability */
  readonly onStateChange?: (
    result: ProcessEventResult<S, E>,
    event: E,
  ) => Effect.Effect<void> | void;
  /** After reply settlement when transition occurred — actor publishes to transitionsPubSub */
  readonly onProcessed?: (result: ProcessEventResult<S, E>, event: E) => Effect.Effect<void> | void;
  /** When final state detected in event loop — actor emits @machine.stop */
  readonly onFinal?: (state: S) => Effect.Effect<void>;
  /** Before stop resource cleanup — actor emits @machine.stop, settles pending replies */
  readonly onShutdown?: () => Effect.Effect<void>;
  /** Before initial spawn effects — actor emits @machine.effect inspection */
  readonly onInitialSpawnEffects?: (state: S) => Effect.Effect<void>;
}

// ============================================================================
// Runtime creation
// ============================================================================

/** @internal */
export interface RuntimeConfig<S, E> {
  readonly actorId: string;
  readonly hooks?: ProcessEventHooks<S, E>;
  /** State and mailbox resources owned by the calling cell. */
  readonly cellResources: RuntimeCellResources<S, E>;
  /** Lifecycle callbacks for actor-specific concerns */
  readonly lifecycle?: RuntimeLifecycleHooks<S, E>;
  /** Called after self.spawn succeeds — actor tracks children */
  readonly onChildSpawned?: <ChildState extends { readonly _tag: string }, ChildEvent>(
    childId: string,
    child: ActorRef<ChildState, ChildEvent>,
  ) => Effect.Effect<void>;
  /** Skip registering stop as scope finalizer — actor manages its own lifecycle */
  readonly skipFinalizer?: boolean;
  /** Prefix for child actor IDs in self.spawn. Entity-machine uses `${actorId}/`. Default: no prefix. */
  readonly childIdPrefix?: string;
}

/** @internal */
export interface ProcessQueuedResult<S, E> {
  readonly shouldStop: boolean;
  readonly stateChanged: boolean;
  readonly result: ProcessEventResult<S, E>;
}

/**
 * Create a runtime for a machine. Returns a handle for sending events
 * and querying state. The runtime owns:
 * - Event loop fiber
 * - Postpone buffer
 * - Background effects (under actorScope)
 * - State scope (spawn effects)
 * - Final state detection
 * - Exit reason via exitDeferred
 *
 * Resources (stateRef, eventQueue, stoppedRef) are either cell-provided
 * or allocated fresh by the runtime.
 *
 * @internal
 */
export const createRuntime = Effect.fn("effect-machine.runtime.create")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance for Machine type params
  machine: Machine<S, E, R, any, any, any, any>,
  system: ActorSystemService,
  config: RuntimeConfig<S, E>,
) {
  const { actorId, hooks, lifecycle } = config;

  // Capture services at allocation so delayed start and stop retain them.
  const services = yield* Effect.context<R>();
  const fork = Effect.runForkWith(services);

  const { stateRef, stoppedRef, eventQueue } = config.cellResources;
  const pendingRequests = new Set<(error: ActorStoppedError) => Effect.Effect<void>>();

  // Exit deferred — set exactly once with the exit reason
  const exitDeferred = yield* Deferred.make<ActorExit<S>>();

  // Actor scope — owns background fibers for this generation
  const actorScope = yield* Scope.make();

  // Pending deferred reply — stored when handler returns Machine.deferReply()
  // Settled by self.reply() from spawn handler
  const deferredReplyRef: {
    current: Deferred.Deferred<unknown, NoReplyError | ActorStoppedError> | undefined;
  } = {
    current: undefined,
  };

  // Self reference — sends go through the same queue
  const selfSend = Effect.fn("effect-machine.runtime.self.send")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (!stopped) {
      yield* Queue.offer(eventQueue, { _tag: "send", event });
    }
  });
  const childPrefix = config.childIdPrefix ?? "";
  const defaultSpawn: MachineRef<E>["spawn"] = (childId, childMachine) =>
    system
      .spawn(`${childPrefix}${childId}`, childMachine)
      .pipe(Effect.provideService(ActorSystemTag, system));
  const onChildSpawned = config.onChildSpawned;
  let spawn: MachineRef<E>["spawn"] = defaultSpawn;
  if (onChildSpawned !== undefined) {
    spawn = (childId, childMachine) =>
      defaultSpawn(childId, childMachine).pipe(
        Effect.tap((child) => onChildSpawned(childId, child)),
      );
  }
  const self: MachineRef<E> = {
    send: selfSend,
    spawn,
    reply: (value: unknown) =>
      Effect.sync(() => {
        const deferred = deferredReplyRef.current;
        if (deferred !== undefined) {
          deferredReplyRef.current = undefined;
          fork(Deferred.succeed(deferred, value));
          return true;
        }
        return false;
      }),
  };

  // State scope for spawn effects
  const stateScopeRef: { current: Scope.Closeable } = {
    current: yield* Scope.make(),
  };

  // Shared mutable refs used by both start() and stop()
  const initEvent = { _tag: INTERNAL_INIT_EVENT } as E;
  // Mutable holder for the loop fiber — needed by stop() and spawn defect signals
  const loopFiberRef: { current: Fiber.Fiber<void> | undefined } = { current: undefined };

  /** Set the exit deferred exactly once. */
  const setExit = (exit: ActorExit<S>) => Deferred.succeed(exitDeferred, exit).pipe(Effect.asVoid);

  // Idempotent start gate — first caller runs initialization, subsequent callers await
  const startDeferred = yield* Deferred.make<void, unknown>();
  const startedRef = yield* Ref.make(false);

  const start = Effect.gen(function* () {
    // Idempotent: if already started, just await completion
    const alreadyStarted = yield* Ref.getAndSet(startedRef, true);
    if (alreadyStarted) {
      yield* Deferred.await(startDeferred);
      return;
    }

    // Initial eventless transitions settle before background and state spawn effects start.
    const initialSpawnDefectSignal = (cause: Cause.Cause<unknown>) =>
      Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "initial-spawn")).pipe(
        Effect.andThen(Ref.set(stoppedRef, true)),
        Effect.andThen(
          Effect.suspend(() => {
            const loopFiber = loopFiberRef.current;
            if (loopFiber !== undefined) return Fiber.interrupt(loopFiber);
            return Effect.void;
          }),
        ),
        Effect.asVoid,
      );
    const initialState = yield* SubscriptionRef.get(stateRef);
    const initialProcessing = processEventCoreImmediate(
      machine,
      initialState,
      initEvent,
      self,
      stateScopeRef,
      system,
      actorId,
      { ...hooks, onSpawnDefect: initialSpawnDefectSignal },
    );
    let initialResult: ProcessEventResult<S, E>;
    if (isEffect(initialProcessing)) {
      initialResult = yield* initialProcessing.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Ref.set(stoppedRef, true);
            yield* Scope.close(stateScopeRef.current, Exit.void);
            yield* Scope.close(actorScope, Exit.void);
            yield* Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "transition"));
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    } else {
      initialResult = initialProcessing;
    }
    if (initialResult.transitioned) {
      yield* SubscriptionRef.set(stateRef, initialResult.newState);
      if (lifecycle?.onStateChange !== undefined) {
        const stateChange = lifecycle.onStateChange(initialResult, initEvent);
        if (isEffect(stateChange)) yield* stateChange;
      }
      if (lifecycle?.onProcessed !== undefined) {
        const processed = lifecycle.onProcessed(initialResult, initEvent);
        if (isEffect(processed)) yield* processed;
      }
    }
    const stableInitialState = initialResult.newState;

    // Fork background effects under actorScope
    const backgroundFibers: Fiber.Fiber<void>[] = [];

    for (const bg of machine._backgroundEffectEntries()) {
      const fiber = yield* bg
        .handler({
          actorId,
          state: stableInitialState,
          event: initEvent,
          self,
          system,
        })
        .pipe(Effect.forkIn(actorScope));
      backgroundFibers.push(fiber);
    }

    // Run initial spawn effects — catch defects, tag as initial-spawn, and propagate.
    // For unsupervised actors this fails createActor (correct: don't register dead actors).
    // For supervised actors (Step 3), the supervision loop will catch and restart.
    if (!initialResult.lifecycleRan && lifecycle?.onInitialSpawnEffects !== undefined) {
      yield* lifecycle.onInitialSpawnEffects(stableInitialState);
    }
    // Note: onSpawnDefect for initial spawn fibers that defect asynchronously (after forking).
    // If they defect later, this signals through exitDeferred and interrupts the loop.
    if (!initialResult.lifecycleRan) {
      yield* runSpawnEffects(
        machine,
        stableInitialState,
        initEvent,
        self,
        stateScopeRef.current,
        system,
        actorId,
        hooks?.onError,
        initialSpawnDefectSignal,
      ).pipe(
        Effect.catchCause((cause) =>
          // Tag as initial-spawn defect, set exit, clean up, then propagate
          Effect.gen(function* () {
            yield* Ref.set(stoppedRef, true);
            yield* Scope.close(stateScopeRef.current, Exit.void);
            yield* Scope.close(actorScope, Exit.void);
            yield* Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "initial-spawn"));
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    }

    // Check if initial state is final — if so, clean up and signal done
    if (machine._isFinal(stableInitialState._tag)) {
      if (lifecycle?.onFinal !== undefined) yield* lifecycle.onFinal(stableInitialState);
      yield* Ref.set(stoppedRef, true);
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Scope.close(actorScope, Exit.void);
      yield* setExit(ActorExit.Final(stableInitialState, stableInitialState));
      yield* Deferred.succeed(startDeferred, undefined);
      return;
    }

    // Augment hooks with spawn defect signal — spawn fibers signal through this
    // instead of dying silently, so the runtime can set exitDeferred and terminate.
    const augmentedHooks: ProcessEventHooks<S, E> = {
      ...hooks,
      onSpawnDefect: (cause: Cause.Cause<unknown>) =>
        Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "spawn")).pipe(
          Effect.andThen(Ref.set(stoppedRef, true)),
          Effect.andThen(
            Effect.suspend(() => {
              const loopFiber = loopFiberRef.current;
              if (loopFiber !== undefined) return Fiber.interrupt(loopFiber);
              return Effect.void;
            }),
          ),
          Effect.asVoid,
        ),
    };

    // Start event loop — forked OUTSIDE actorScope (not a background fiber).
    // The generation owner fiber below observes its exit and closes actorScope.
    const loopFiber = yield* runtimeEventLoop(
      machine,
      stateRef,
      eventQueue,
      pendingRequests,
      stoppedRef,
      self,
      stateScopeRef,
      actorId,
      system,
      exitDeferred,
      augmentedHooks,
      deferredReplyRef,
      lifecycle,
      fork,
    ).pipe(Effect.provide(services), Effect.forkDetach);
    loopFiberRef.current = loopFiber;

    // Background defect observer: Fiber.await each background fiber.
    // forkIn defects are silent (not propagated to scope), so we must explicitly watch them.
    // On defect: set exitDeferred with phase "background", then interrupt the event loop.
    // Interrupt-only exits are normal lifecycle (scope close on stop/final) — not defects.
    // Forked INTO actorScope — gets interrupted when actorScope closes (no leak).
    if (backgroundFibers.length > 0) {
      yield* Effect.raceAll(
        backgroundFibers.map((fiber) =>
          Fiber.await(fiber).pipe(
            Effect.flatMap((exit) => {
              if (exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)) {
                return setExit(ActorExit.Defect(exit.cause, "background")).pipe(
                  Effect.andThen(Ref.set(stoppedRef, true)),
                  Effect.andThen(Fiber.interrupt(loopFiber)),
                );
              }
              // Normal exit or clean interrupt — ignore, wait forever (scope close will interrupt)
              return Effect.never;
            }),
          ),
        ),
      ).pipe(Effect.forkIn(actorScope));
    }

    // Generation owner: observes loop exit, then closes actorScope to clean up
    // background fibers. The loop sets exitDeferred before exiting.
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        const loopExit = yield* Fiber.await(loopFiber);
        // Close actorScope — interrupts background fibers and their defect watchers
        if (loopExit._tag === "Success") {
          yield* Scope.close(actorScope, Exit.void);
        } else {
          yield* Scope.close(actorScope, loopExit);
        }
      }),
    );

    yield* Deferred.succeed(startDeferred, undefined);
  }).pipe(
    Effect.catchCause((cause) =>
      Ref.set(stoppedRef, true).pipe(
        Effect.andThen(Scope.close(stateScopeRef.current, Exit.void)),
        Effect.andThen(Scope.close(actorScope, Exit.void)),
        Effect.andThen(setExit(ActorExit.Defect(cause, "transition"))),
        Effect.andThen(Deferred.failCause(startDeferred, cause)),
        Effect.andThen(Effect.failCause(cause)),
      ),
    ),
  );

  const stop = Effect.gen(function* () {
    const alreadyStopped = yield* Ref.get(stoppedRef);
    if (alreadyStopped) return;
    if (lifecycle?.onShutdown !== undefined) yield* lifecycle.onShutdown();
    yield* settlePendingRequests(pendingRequests, actorId);
    yield* Ref.set(stoppedRef, true);
    const loopFiber = loopFiberRef.current;
    if (loopFiber !== undefined) {
      yield* Fiber.interrupt(loopFiber);
    }
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Scope.close(actorScope, Exit.void);
    yield* setExit(ActorExit.Stopped as ActorExit<S>);
  }).pipe(Effect.asVoid);

  // Register stop as scope finalizer so entity teardown cleans up fibers.
  // Skipped for actor.ts which manages its own stop lifecycle.
  if (config.skipFinalizer !== true) {
    yield* Effect.addFinalizer(() => stop);
  }

  return {
    ...makeHandle(actorId, stateRef, stoppedRef, eventQueue, pendingRequests, exitDeferred),
    stop: stop.pipe(Effect.provide(services)),
    start: start.pipe(Effect.provide(services)),
  };
});

/**
 * Build the runtime handle.
 * Shared between initial-final and normal paths.
 */
const makeHandle = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  actorId: string,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  stoppedRef: Ref.Ref<boolean>,
  eventQueue: Queue.Queue<RuntimeQueuedEvent<S, E>>,
  pendingRequests: Set<(error: ActorStoppedError) => Effect.Effect<void>>,
  exitDeferred: Deferred.Deferred<ActorExit<S>>,
): RuntimeHandle<S, E> => {
  const track = <A, RequestError>(
    deferred: Deferred.Deferred<A, RequestError>,
    settle: (error: ActorStoppedError) => Effect.Effect<void>,
  ) => {
    pendingRequests.add(settle);
    return Deferred.await(deferred).pipe(
      Effect.ensuring(Effect.sync(() => pendingRequests.delete(settle))),
    );
  };

  const send = (event: E) =>
    Ref.get(stoppedRef).pipe(
      Effect.flatMap((stopped) => {
        if (stopped) return Effect.void;
        return Queue.offer(eventQueue, { _tag: "send", event }).pipe(Effect.asVoid);
      }),
    );

  return {
    send,
    sendWait: (event: E) =>
      Effect.gen(function* () {
        const stopped = yield* Ref.get(stoppedRef);
        if (!stopped) {
          const done = yield* Deferred.make<void, unknown>();
          yield* Queue.offer(eventQueue, { _tag: "sendWait", event, done });
          yield* track(done, (error) => Deferred.fail(done, error).pipe(Effect.asVoid));
        }
      }),
    call: (event: E) =>
      Effect.gen(function* () {
        const stopped = yield* Ref.get(stoppedRef);
        if (stopped) return yield* ActorStoppedError.make({ actorId });
        const reply = yield* Deferred.make<ProcessEventResult<S, E>, ActorStoppedError>();
        yield* Queue.offer(eventQueue, { _tag: "call", event, reply });
        return yield* track(reply, (error) => Deferred.fail(reply, error).pipe(Effect.asVoid));
      }),
    ask: (event: E) =>
      Effect.gen(function* () {
        const stopped = yield* Ref.get(stoppedRef);
        if (stopped) {
          return yield* ActorStoppedError.make({ actorId });
        }
        const reply = yield* Deferred.make<unknown, NoReplyError | ActorStoppedError>();
        yield* Queue.offer(eventQueue, { _tag: "ask", event, reply });
        return yield* track(reply, (error) => Deferred.fail(reply, error).pipe(Effect.asVoid));
      }),
    drain: Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (stopped) return;
      const done = yield* Deferred.make<void>();
      yield* Queue.offer(eventQueue, { _tag: "drain", done });
      yield* Deferred.await(done);
    }).pipe(Effect.asVoid),
    sendSync: (event: E) => {
      const stopped = Effect.runSync(Ref.get(stoppedRef));
      if (!stopped) Effect.runSync(Queue.offer(eventQueue, { _tag: "send", event }));
    },
    getState: SubscriptionRef.get(stateRef),
    stateRef,
    stop: Effect.void,
    start: Effect.void,
    settlePendingRequests: settlePendingRequests(pendingRequests, actorId),
    exitDeferred,
  };
};

const settlePendingRequests = (
  pendingRequests: Set<(error: ActorStoppedError) => Effect.Effect<void>>,
  actorId: string,
) =>
  Effect.gen(function* () {
    const error = ActorStoppedError.make({ actorId });
    for (const settle of pendingRequests) yield* settle(error);
    pendingRequests.clear();
  });

// ============================================================================
// Event loop
// ============================================================================

const runtimeEventLoop = Effect.fn("effect-machine.runtime.eventLoop")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance
  machine: Machine<S, E, R, any, any, any, any>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<RuntimeQueuedEvent<S, E>>,
  pendingRequests: Set<(error: ActorStoppedError) => Effect.Effect<void>>,
  stoppedRef: Ref.Ref<boolean>,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  actorId: string,
  system: ActorSystemService,
  exitDeferred: Deferred.Deferred<ActorExit<S>>,
  hooks?: ProcessEventHooks<S, E>,
  deferredReplyRef?: {
    current: Deferred.Deferred<unknown, NoReplyError | ActorStoppedError> | undefined;
  },
  lifecycle?: RuntimeLifecycleHooks<S, E>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fork?: (effect: Effect.Effect<any>) => Fiber.Fiber<any>,
) {
  // Fire-and-forget fork with captured services
  const forkEffect = fork ?? Effect.runFork;

  // Event-bearing queue variants (excludes drain sentinel)
  type EventQueued = Exclude<RuntimeQueuedEvent<S, E>, { readonly _tag: "drain" }>;

  /** Set the exit deferred exactly once. */
  const setExit = (exit: ActorExit<S>) => Deferred.succeed(exitDeferred, exit).pipe(Effect.asVoid);

  const postponeQueued = Effect.fn("effect-machine.runtime.postponeQueued")(function* (
    currentState: S,
    queued: EventQueued,
  ) {
    const event = queued.event;
    const postponedResult: ProcessEventResult<S, E> = {
      newState: currentState,
      previousState: currentState,
      transitioned: false,
      lifecycleRan: false,
      isFinal: false,
      hasReply: false,
      deferReply: false,
      reply: undefined,
      postponed: true,
      transitions: [],
    };

    let input: EventQueued = queued;
    if (queued._tag === "call") {
      yield* Deferred.succeed(queued.reply, postponedResult);
      input = { _tag: "send", event };
    } else if (queued._tag === "sendWait") {
      yield* Deferred.succeed(queued.done, undefined);
      input = { _tag: "send", event };
    }

    return {
      input,
      value: { shouldStop: false, stateChanged: false, result: postponedResult },
    };
  });

  const processQueued = (currentState: S, queued: EventQueued) =>
    Effect.gen(function* () {
      const event = queued.event;

      // Lifecycle: onEvent (actor emits @machine.event)
      if (lifecycle?.onEvent !== undefined) yield* lifecycle.onEvent(currentState, event);

      // Process event through core
      const processing = processEventCoreImmediate(
        machine,
        currentState,
        event,
        self,
        stateScopeRef,
        system,
        actorId,
        hooks,
      );
      let result: ProcessEventResult<S, E>;
      if (isEffect(processing)) {
        result = yield* processing;
      } else {
        result = processing;
      }

      // Update state if transitioned
      if (result.transitioned) {
        yield* SubscriptionRef.set(stateRef, result.newState);
      }

      // Lifecycle: onStateChange (actor notifies listeners and saves durability)
      if (lifecycle?.onStateChange !== undefined && result.transitioned) {
        const stateChange = lifecycle.onStateChange(result, event);
        if (isEffect(stateChange)) yield* stateChange;
      }

      // Settle reply/done Deferreds
      switch (queued._tag) {
        case "call":
          yield* Deferred.succeed(queued.reply, result);
          break;
        case "sendWait":
          yield* Deferred.succeed(queued.done, undefined);
          break;
        case "ask":
          if (result.hasReply) {
            const replySchema = machine._replySchema(event._tag);
            if (replySchema !== undefined) {
              const decoded = yield* Schema.decodeUnknownEffect(replySchema)(result.reply).pipe(
                Effect.catch((decodeError) =>
                  Effect.gen(function* () {
                    yield* Deferred.die(queued.reply, decodeError);
                    return yield* Effect.die(decodeError);
                  }),
                ),
              );
              yield* Deferred.succeed(queued.reply, decoded);
            } else {
              yield* Deferred.succeed(queued.reply, result.reply);
            }
          } else if (result.deferReply && deferredReplyRef !== undefined) {
            // Handler returned Machine.deferReply() — spawn handler will call self.reply()
            deferredReplyRef.current = queued.reply;
          } else {
            yield* Deferred.fail(
              queued.reply,
              NoReplyError.make({ actorId, eventTag: event._tag }),
            );
          }
          break;
      }

      // Lifecycle: onProcessed (actor publishes to transitionsPubSub)
      if (lifecycle?.onProcessed !== undefined && result.transitioned) {
        const processed = lifecycle.onProcessed(result, event);
        if (isEffect(processed)) yield* processed;
      }

      const shouldStop = result.isFinal && result.lifecycleRan;

      // Lifecycle: onFinal (actor emits @machine.stop)
      if (shouldStop && lifecycle?.onFinal !== undefined) {
        yield* lifecycle.onFinal(result.newState);
      }

      return {
        shouldStop,
        stateChanged: result.lifecycleRan,
        result,
      };
    });

  const initialState = yield* SubscriptionRef.get(stateRef);
  let currentState = initialState;
  const makePostponeAdvancement = () =>
    makeEventAdvancement({
      initial: initialState,
      isFinal: (state: S) => machine._isFinal(state._tag),
      shouldPostpone: (state: S, queued: EventQueued) =>
        shouldPostpone(machine, state._tag, queued.event._tag),
      postpone: postponeQueued,
      process: (state: S, queued: EventQueued, _draining: boolean) =>
        processQueued(state, queued).pipe(
          Effect.map((processed) => ({
            state: processed.result.newState,
            transitioned: processed.result.transitioned,
            stateChanged: processed.stateChanged,
            shouldStop: processed.shouldStop,
            value: processed,
          })),
        ),
      discard: (queued: EventQueued) => {
        if (queued._tag === "ask") {
          return Deferred.fail(
            queued.reply,
            NoReplyError.make({ actorId, eventTag: queued.event._tag }),
          ).pipe(Effect.asVoid);
        }
        return Effect.void;
      },
    });
  let advancement: ReturnType<typeof makePostponeAdvancement> | undefined;
  if (machine._hasPostponeRules()) {
    advancement = makePostponeAdvancement();
  }

  // Shutdown helper — settles postponed, drains queue, closes scopes
  const shutdown = (exitReason: ActorExit<S>) =>
    Effect.gen(function* () {
      yield* Ref.set(stoppedRef, true);
      if (lifecycle?.onShutdown !== undefined) yield* lifecycle.onShutdown();
      if (advancement !== undefined) yield* advancement.close();
      // Drain remaining events non-blocking
      const remaining = yield* Queue.clear(eventQueue);
      for (const entry of remaining) {
        if (entry._tag === "sendWait") {
          forkEffect(Deferred.succeed(entry.done, undefined));
        } else if (entry._tag === "ask") {
          forkEffect(
            Deferred.fail(entry.reply, NoReplyError.make({ actorId, eventTag: entry.event._tag })),
          );
        } else if (entry._tag === "call") {
          // Settle with a stopped result
          const state = yield* SubscriptionRef.get(stateRef);
          forkEffect(
            Deferred.succeed(entry.reply, {
              newState: state,
              previousState: state,
              transitioned: false,
              lifecycleRan: false,
              isFinal: machine._isFinal(state._tag),
              hasReply: false,
              deferReply: false,
              reply: undefined,
              postponed: false,
              transitions: [],
            }),
          );
        }
      }
      yield* Scope.close(stateScopeRef.current, Exit.void);
      // actorScope is closed by the generation owner fiber (which observes loop exit),
      // or by stop(). Not closed here — the loop just sets the exit reason and returns.
      yield* setExit(exitReason);
    });

  while (true) {
    const queued = yield* Queue.take(eventQueue);

    // Drain: graceful shutdown — process remaining queue then stop
    if (queued._tag === "drain") {
      yield* shutdown(ActorExit.Stopped as ActorExit<S>);
      yield* Deferred.succeed(queued.done, undefined);
      return;
    }

    // queued is narrowed: drain is handled above, so it is always an event-bearing variant here
    const eventQueued = queued;
    const catchEventDefect = <A, R1>(effect: Effect.Effect<A, never, R1>) =>
      effect.pipe(
        Effect.catchCause((cause) => {
          // On defect: settle the current event's Deferred, run shutdown cleanup, then die
          if (queued._tag === "sendWait") {
            forkEffect(Deferred.failCause(queued.done, cause));
          } else if (queued._tag === "ask") {
            forkEffect(Deferred.die(queued.reply, cause));
          } else if (queued._tag === "call") {
            forkEffect(Deferred.failCause(queued.reply, cause));
          }
          const phase: DefectPhase = "transition";
          return shutdown(ActorExit.Defect(cause, phase)).pipe(
            Effect.andThen(Effect.failCause(cause)),
          );
        }),
      );

    let stopped: boolean;
    if (advancement === undefined) {
      const processed = yield* catchEventDefect(processQueued(currentState, eventQueued));
      currentState = processed.result.newState;
      stopped = processed.shouldStop;
    } else {
      const advanced = yield* catchEventDefect(advancement.advance(eventQueued));
      stopped = advanced.stopped;
    }

    if (stopped) {
      const finalState = yield* SubscriptionRef.get(stateRef);
      yield* shutdown(ActorExit.Final(finalState, finalState));
      return;
    }
  }
});
