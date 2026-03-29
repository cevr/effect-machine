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
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag } from "../actor.js";
import type { ProcessEventHooks, ProcessEventResult } from "./transition.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { processEventCore, runSpawnEffects, shouldPostpone } from "./transition.js";
import { NoReplyError } from "../errors.js";
import { INTERNAL_INIT_EVENT } from "./utils.js";
import { ActorExit, type DefectPhase } from "../supervision.js";

// ============================================================================
// QueuedEvent — unified type for all event loop consumers
// ============================================================================

/** @internal */
export type RuntimeQueuedEvent<E> =
  | { readonly _tag: "send"; readonly event: E }
  | {
      readonly _tag: "sendWait";
      readonly event: E;
      readonly done: Deferred.Deferred<void>;
    }
  | {
      readonly _tag: "call";
      readonly event: E;
      readonly reply: Deferred.Deferred<ProcessEventResult<{ readonly _tag: string }>, unknown>;
    }
  | {
      readonly _tag: "ask";
      readonly event: E;
      readonly reply: Deferred.Deferred<unknown, NoReplyError>;
    }
  | {
      readonly _tag: "drain";
      readonly done: Deferred.Deferred<void, never>;
    };

// ============================================================================
// Cell resources — stable across runtime generations
// ============================================================================

/**
 * Resources owned by the actor cell (stable across generations).
 * When provided, createRuntime uses these instead of allocating its own.
 * @internal
 */
export interface RuntimeCellResources<S, E> {
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  readonly eventQueue: Queue.Queue<RuntimeQueuedEvent<E>>;
  readonly stoppedRef: Ref.Ref<boolean>;
}

// ============================================================================
// Runtime interface
// ============================================================================

/** @internal */
export interface RuntimeHandle<S, E> {
  /** Enqueue a fire-and-forget event */
  readonly send: (event: E) => Effect.Effect<void>;
  /** Enqueue event and wait for processing to complete (for RPC Send) */
  readonly sendWait: (event: E) => Effect.Effect<void>;
  /** Enqueue an ask event, returns the reply value */
  readonly ask: (event: E) => Effect.Effect<unknown, NoReplyError>;
  /** Get current state */
  readonly getState: Effect.Effect<S>;
  /** SubscriptionRef for state observation */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  /** Whether the runtime has stopped (final state reached) */
  readonly isStopped: Effect.Effect<boolean>;
  /** Stop the runtime (interrupt event loop, clean up) */
  readonly stop: Effect.Effect<void>;
  /** @internal — raw event queue for direct enqueue (actor.ts uses this for pendingReplies tracking) */
  readonly _queue: Queue.Queue<RuntimeQueuedEvent<E>>;
  /** @internal — stopped ref for direct access */
  readonly _stoppedRef: Ref.Ref<boolean>;
  /**
   * Exit deferred — set exactly once with the exit reason when the runtime stops.
   * Final state → ActorExit.Final, explicit stop → ActorExit.Stopped, defect → ActorExit.Defect.
   */
  readonly exitDeferred: Deferred.Deferred<ActorExit<S>, never>;
  /**
   * Actor scope — owns background fibers for this generation.
   * Closing this scope interrupts all background fibers.
   */
  readonly actorScope: Scope.CloseableScope;
}

// ============================================================================
// Lifecycle hooks — actor-specific concerns injected into the kernel
// ============================================================================

/** @internal */
export interface RuntimeLifecycleHooks<S, E> {
  /** Before processEventCore — actor emits @machine.event inspection */
  readonly onEvent?: (state: S, event: E) => Effect.Effect<void>;
  /** After SubscriptionRef.set on transition — actor notifies listeners, annotates spans */
  readonly onStateChange?: (result: ProcessEventResult<S>, event: E) => Effect.Effect<void>;
  /** After reply settlement when transition occurred — actor publishes to transitionsPubSub */
  readonly onProcessed?: (result: ProcessEventResult<S>, event: E) => Effect.Effect<void>;
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
  /**
   * Cell-owned resources. When provided, the runtime uses the cell's stateRef,
   * eventQueue, and stoppedRef instead of creating its own.
   * Used by actor.ts for supervision (cell owns stable resources across generations).
   */
  readonly cellResources?: RuntimeCellResources<S, E>;
  /**
   * Custom queue factory. Default: `Queue.unbounded()`.
   * Use `Queue.sliding(n)` or `Queue.dropping(n)` for bounded queues.
   * Ignored when cellResources is provided.
   */
  readonly queueFactory?: Effect.Effect<Queue.Queue<RuntimeQueuedEvent<E>>>;
  /** Lifecycle callbacks for actor-specific concerns */
  readonly lifecycle?: RuntimeLifecycleHooks<S, E>;
  /** Wrap each processQueued invocation — actor uses for span annotations */
  readonly wrapProcess?: (
    state: S,
    event: E,
    inner: Effect.Effect<ProcessQueuedResult<S>>,
  ) => Effect.Effect<ProcessQueuedResult<S>>;
  /** Called after self.spawn succeeds — actor tracks children */
  readonly onChildSpawned?: (childId: string, child: unknown) => Effect.Effect<void>;
  /** Skip registering stop as scope finalizer — actor manages its own lifecycle */
  readonly skipFinalizer?: boolean;
  /** Prefix for child actor IDs in self.spawn. Entity-machine uses `${actorId}/`. Default: no prefix. */
  readonly childIdPrefix?: string;
}

/** @internal */
export interface ProcessQueuedResult<S> {
  readonly shouldStop: boolean;
  readonly stateChanged: boolean;
  readonly result: ProcessEventResult<S>;
}

/**
 * Create a runtime for a machine. Returns a handle for sending events
 * and querying state. The runtime owns:
 * - Event loop fiber
 * - Postpone buffer
 * - Background effects
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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance for Machine type params
  machine: Machine<S, E, R, any, any, GD, EFD>,
  system: ActorSystem,
  config: RuntimeConfig<S, E>,
) {
  const { actorId, hooks, lifecycle } = config;

  // Resources: use cell-provided or allocate fresh
  const stateRef =
    config.cellResources?.stateRef ?? (yield* SubscriptionRef.make<S>(machine.initial));
  const stoppedRef = config.cellResources?.stoppedRef ?? (yield* Ref.make(false));
  const eventQueue =
    config.cellResources?.eventQueue ??
    (yield* config.queueFactory ?? Queue.unbounded<RuntimeQueuedEvent<E>>());

  // Exit deferred — set exactly once with the exit reason
  const exitDeferred = yield* Deferred.make<ActorExit<S>, never>();

  // Actor scope — owns background fibers for this generation
  const actorScope = yield* Scope.make();

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
  const self: MachineRef<E> = {
    send: selfSend,
    cast: selfSend,
    spawn:
      onChildSpawned !== undefined
        ? (childId, childMachine) =>
            defaultSpawn(childId, childMachine).pipe(
              Effect.tap((child) => onChildSpawned(childId, child)),
            )
        : defaultSpawn,
  };

  // State scope for spawn effects
  const stateScopeRef: { current: Scope.CloseableScope } = {
    current: yield* Scope.make(),
  };

  // Fork background effects into actorScope
  const backgroundFibers: Fiber.Fiber<void, never>[] = [];
  const initEvent = { _tag: INTERNAL_INIT_EVENT } as E;
  const ctx: MachineContext<S, E, MachineRef<E>> = {
    actorId,
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
          actorId,
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

  // Run initial spawn effects
  if (lifecycle?.onInitialSpawnEffects !== undefined) {
    yield* lifecycle.onInitialSpawnEffects(machine.initial);
  }

  // Mutable holder for the loop fiber — spawn defect signals need to interrupt the loop
  const loopFiberRef: { current: Fiber.Fiber<void, never> | undefined } = { current: undefined };

  // Spawn defect signal for initial spawn fibers that defect asynchronously
  const initialSpawnDefectSignal = (cause: Cause.Cause<unknown>) =>
    Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "initial-spawn")).pipe(
      Effect.zipRight(Ref.set(stoppedRef, true)),
      Effect.zipRight(
        Effect.suspend(() =>
          loopFiberRef.current !== undefined ? Fiber.interrupt(loopFiberRef.current) : Effect.void,
        ),
      ),
      Effect.asVoid,
    );

  yield* runSpawnEffects(
    machine,
    machine.initial,
    initEvent,
    self,
    stateScopeRef.current,
    system,
    actorId,
    hooks?.onError,
    initialSpawnDefectSignal,
  ).pipe(
    Effect.catchAllCause((cause) => {
      return Effect.gen(function* () {
        yield* Ref.set(stoppedRef, true);
        yield* Scope.close(stateScopeRef.current, Exit.void);
        yield* Scope.close(actorScope, Exit.void);
        yield* Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "initial-spawn"));
        return yield* Effect.failCause(cause);
      });
    }),
  );

  /** Set the exit deferred exactly once. */
  const setExit = (exit: ActorExit<S>) => Deferred.succeed(exitDeferred, exit).pipe(Effect.asVoid);

  // Check if initial state is final
  if (machine.finalStates.has(machine.initial._tag)) {
    if (lifecycle?.onFinal !== undefined) yield* lifecycle.onFinal(machine.initial);
    yield* Ref.set(stoppedRef, true);
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Scope.close(actorScope, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* setExit(ActorExit.Final(machine.initial));
    return makeHandle(stateRef, stoppedRef, eventQueue, exitDeferred, actorScope);
  }

  // Augment hooks with spawn defect signal
  const augmentedHooks: ProcessEventHooks<S, E> = {
    ...hooks,
    onSpawnDefect: (cause: Cause.Cause<unknown>) =>
      Deferred.succeed(exitDeferred, ActorExit.Defect(cause, "spawn")).pipe(
        Effect.zipRight(Ref.set(stoppedRef, true)),
        Effect.zipRight(
          Effect.suspend(() =>
            loopFiberRef.current !== undefined
              ? Fiber.interrupt(loopFiberRef.current)
              : Effect.void,
          ),
        ),
        Effect.asVoid,
      ),
  };

  // Start event loop
  const loopFiber = yield* Effect.forkDaemon(
    runtimeEventLoop(
      machine,
      stateRef,
      eventQueue,
      stoppedRef,
      self,
      stateScopeRef,
      actorId,
      system,
      exitDeferred,
      augmentedHooks,
      lifecycle,
      config.wrapProcess,
    ),
  );
  loopFiberRef.current = loopFiber;

  // Background defect observer
  if (backgroundFibers.length > 0) {
    yield* Effect.forkDaemon(
      Effect.raceAll(
        backgroundFibers.map((fiber) =>
          Fiber.await(fiber).pipe(
            Effect.flatMap((exit) => {
              if (exit._tag === "Failure" && !Cause.isInterruptedOnly(exit.cause)) {
                return setExit(ActorExit.Defect(exit.cause, "background")).pipe(
                  Effect.zipRight(Ref.set(stoppedRef, true)),
                  Effect.zipRight(Fiber.interrupt(loopFiber)),
                );
              }
              return Effect.never;
            }),
          ),
        ),
      ).pipe(Effect.catchAllCause(() => Effect.void)),
    );
  }

  const stop = Effect.gen(function* () {
    const alreadyStopped = yield* Ref.get(stoppedRef);
    if (alreadyStopped) return;
    if (lifecycle?.onShutdown !== undefined) yield* lifecycle.onShutdown();
    yield* Ref.set(stoppedRef, true);
    yield* Fiber.interrupt(loopFiber);
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Scope.close(actorScope, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* setExit(ActorExit.Stopped as ActorExit<S>);
  }).pipe(Effect.asVoid);

  // Register stop as scope finalizer so entity teardown cleans up fibers.
  // Skipped for actor.ts which manages its own stop lifecycle.
  if (config.skipFinalizer !== true) {
    yield* Effect.addFinalizer(() => stop);
  }

  return {
    ...makeHandle(stateRef, stoppedRef, eventQueue, exitDeferred, actorScope),
    stop,
  };
});

/**
 * Build the runtime handle (send/ask/getState/isStopped).
 * Shared between initial-final and normal paths.
 */
const makeHandle = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  stoppedRef: Ref.Ref<boolean>,
  eventQueue: Queue.Queue<RuntimeQueuedEvent<E>>,
  exitDeferred: Deferred.Deferred<ActorExit<S>, never>,
  actorScope: Scope.CloseableScope,
): RuntimeHandle<S, E> => ({
  send: (event: E) =>
    Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (!stopped) {
        yield* Queue.offer(eventQueue, { _tag: "send", event });
      }
    }),
  sendWait: (event: E) =>
    Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (!stopped) {
        const done = yield* Deferred.make<void>();
        yield* Queue.offer(eventQueue, { _tag: "sendWait", event, done });
        yield* Deferred.await(done);
      }
    }),
  ask: (event: E) =>
    Effect.gen(function* () {
      const stopped = yield* Ref.get(stoppedRef);
      if (stopped) {
        return yield* new NoReplyError({ actorId: "stopped", eventTag: event._tag });
      }
      const reply = yield* Deferred.make<unknown, NoReplyError>();
      yield* Queue.offer(eventQueue, { _tag: "ask", event, reply });
      return yield* Deferred.await(reply);
    }),
  getState: SubscriptionRef.get(stateRef),
  stateRef,
  isStopped: Ref.get(stoppedRef),
  stop: Effect.void,
  _queue: eventQueue,
  _stoppedRef: stoppedRef,
  exitDeferred,
  actorScope,
});

// ============================================================================
// Event loop
// ============================================================================

const runtimeEventLoop = Effect.fn("effect-machine.runtime.eventLoop")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<RuntimeQueuedEvent<E>>,
  stoppedRef: Ref.Ref<boolean>,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.CloseableScope },
  actorId: string,
  system: ActorSystem,
  exitDeferred: Deferred.Deferred<ActorExit<S>, never>,
  hooks?: ProcessEventHooks<S, E>,
  lifecycle?: RuntimeLifecycleHooks<S, E>,
  wrapProcess?: (
    state: S,
    event: E,
    inner: Effect.Effect<ProcessQueuedResult<S>>,
  ) => Effect.Effect<ProcessQueuedResult<S>>,
) {
  // Event-bearing queue variants (excludes drain sentinel)
  type EventQueued = Exclude<RuntimeQueuedEvent<E>, { readonly _tag: "drain" }>;

  /** Set the exit deferred exactly once. */
  const setExit = (exit: ActorExit<S>) => Deferred.succeed(exitDeferred, exit).pipe(Effect.asVoid);

  // Postpone buffer — only event-bearing variants, never drain
  const postponed: EventQueued[] = [];
  const hasPostponeRules = machine.postponeRules.length > 0;
  const processQueued = Effect.fn("effect-machine.runtime.processQueued")(function* (
    queued: EventQueued,
  ) {
    const event = queued.event;
    const currentState = yield* SubscriptionRef.get(stateRef);

    // Check postpone rules
    if (hasPostponeRules && shouldPostpone(machine, currentState._tag, event._tag)) {
      // For call: settle immediately with postponed result, push into buffer for re-processing
      if (queued._tag === "call") {
        const postponedResult: ProcessEventResult<{ readonly _tag: string }> = {
          newState: currentState,
          previousState: currentState,
          transitioned: false,
          lifecycleRan: false,
          isFinal: false,
          hasReply: false,
          deferReply: false,
          reply: undefined,
          postponed: true,
        };
        yield* Deferred.succeed(queued.reply, postponedResult);
      }
      // For sendWait: settle immediately so RPC caller doesn't block
      if (queued._tag === "sendWait") {
        yield* Deferred.succeed(queued.done, undefined);
      }
      // Buffer event for drain — downcast to send since Deferreds are already settled
      postponed.push({ _tag: "send", event });
      const noopResult: ProcessEventResult<S> = {
        newState: currentState,
        previousState: currentState,
        transitioned: false,
        lifecycleRan: false,
        isFinal: false,
        hasReply: false,
        deferReply: false,
        reply: undefined,
        postponed: true,
      };
      return { shouldStop: false, stateChanged: false, result: noopResult };
    }

    // Lifecycle: onEvent (actor emits @machine.event)
    if (lifecycle?.onEvent !== undefined) yield* lifecycle.onEvent(currentState, event);

    // Process event through core
    const result: ProcessEventResult<S> = yield* processEventCore(
      machine,
      currentState,
      event,
      self,
      stateScopeRef,
      system,
      actorId,
      hooks,
    );

    // Update state if transitioned
    if (result.transitioned) {
      yield* SubscriptionRef.set(stateRef, result.newState);
    }

    // Lifecycle: onStateChange (actor notifies listeners, annotates spans)
    if (lifecycle?.onStateChange !== undefined && result.transitioned) {
      yield* lifecycle.onStateChange(result, event);
    }

    // Settle reply/done Deferreds
    switch (queued._tag) {
      case "call":
        yield* Deferred.succeed(
          queued.reply,
          result as ProcessEventResult<{ readonly _tag: string }>,
        );
        break;
      case "sendWait":
        yield* Deferred.succeed(queued.done, undefined);
        break;
      case "ask":
        if (result.hasReply) {
          const replySchema = machine._replySchemas?.get(event._tag);
          if (replySchema !== undefined) {
            let decoded: unknown;
            // @effect-diagnostics tryCatchInEffectGen:off
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema.Any has R=unknown, decodeUnknownSync needs R=never
              decoded = Schema.decodeUnknownSync(replySchema as Schema.Schema<any, any, never>)(
                result.reply,
              );
            } catch (decodeError) {
              yield* Deferred.die(queued.reply, decodeError);
              return yield* Effect.die(decodeError);
            }
            yield* Deferred.succeed(queued.reply, decoded);
          } else {
            yield* Deferred.succeed(queued.reply, result.reply);
          }
        } else {
          yield* Deferred.fail(queued.reply, new NoReplyError({ actorId, eventTag: event._tag }));
        }
        break;
    }

    // Lifecycle: onProcessed (actor publishes to transitionsPubSub)
    if (lifecycle?.onProcessed !== undefined && result.transitioned) {
      yield* lifecycle.onProcessed(result, event);
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

  // Shutdown helper — settles postponed, drains queue, closes scopes
  const shutdown = (exitReason: ActorExit<S>) =>
    Effect.gen(function* () {
      yield* Ref.set(stoppedRef, true);
      if (lifecycle?.onShutdown !== undefined) yield* lifecycle.onShutdown();
      settlePostponed(postponed, actorId);
      // Drain remaining events from queue and settle their Deferreds
      const remaining = yield* Queue.takeAll(eventQueue);
      for (const entry of remaining) {
        if (entry._tag === "sendWait") {
          Effect.runFork(Deferred.succeed(entry.done, undefined));
        } else if (entry._tag === "ask") {
          Effect.runFork(
            Deferred.fail(entry.reply, new NoReplyError({ actorId, eventTag: entry.event._tag })),
          );
        } else if (entry._tag === "call") {
          // Settle with a stopped result
          const currentState = yield* SubscriptionRef.get(stateRef);
          Effect.runFork(
            Deferred.succeed(entry.reply, {
              newState: currentState,
              previousState: currentState,
              transitioned: false,
              lifecycleRan: false,
              isFinal: machine.finalStates.has(currentState._tag),
              hasReply: false,
              deferReply: false,
              reply: undefined,
              postponed: false,
            }),
          );
        }
      }
      yield* Scope.close(stateScopeRef.current, Exit.void);
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

    // queued is narrowed: drain is handled above, so it's always an event-bearing variant here
    const eventQueued = queued as Exclude<RuntimeQueuedEvent<E>, { readonly _tag: "drain" }>;
    const processInner = processQueued(eventQueued) as Effect.Effect<ProcessQueuedResult<S>>;
    const wrapped =
      wrapProcess !== undefined
        ? Effect.gen(function* () {
            const currentState = yield* SubscriptionRef.get(stateRef);
            return yield* wrapProcess(currentState, eventQueued.event, processInner);
          })
        : processInner;

    const { shouldStop, stateChanged } = yield* wrapped.pipe(
      Effect.catchAllCause((cause) => {
        // On defect: settle the current event's Deferred, run shutdown cleanup, then die
        if (queued._tag === "sendWait") {
          Effect.runFork(Deferred.succeed(queued.done, undefined));
        } else if (queued._tag === "ask") {
          Effect.runFork(Deferred.die(queued.reply, cause));
        } else if (queued._tag === "call") {
          Effect.runFork(Deferred.failCause(queued.reply, cause));
        }
        const phase: DefectPhase = "transition";
        return shutdown(ActorExit.Defect(cause, phase)).pipe(
          Effect.zipRight(Effect.failCause(cause)),
        );
      }),
    );

    if (shouldStop) {
      const finalState = yield* SubscriptionRef.get(stateRef);
      yield* shutdown(ActorExit.Final(finalState));
      return;
    }

    // Drain postponed events — loop until stable
    let drainTriggered = stateChanged;
    while (drainTriggered && postponed.length > 0) {
      drainTriggered = false;
      const drained = postponed.splice(0);
      for (const entry of drained) {
        const drain = yield* processQueued(entry);
        if (drain.shouldStop) {
          const finalState = yield* SubscriptionRef.get(stateRef);
          yield* shutdown(ActorExit.Final(finalState));
          return;
        }
        if (drain.stateChanged) {
          drainTriggered = true;
        }
      }
    }
  }
});

/** Settle all pending Deferreds in the postpone buffer on shutdown. */
const settlePostponed = <E extends { readonly _tag: string }>(
  postponed: Exclude<RuntimeQueuedEvent<E>, { readonly _tag: "drain" }>[],
  actorId: string,
): void => {
  for (const entry of postponed) {
    if (entry._tag === "ask") {
      Effect.runFork(
        Deferred.fail(entry.reply, new NoReplyError({ actorId, eventTag: entry.event._tag })),
      );
    } else if (entry._tag === "sendWait") {
      Effect.runFork(Deferred.succeed(entry.done, undefined));
    }
    // call entries in postpone buffer were already settled on postpone
    // send entries have no Deferred
  }
  postponed.length = 0;
};
