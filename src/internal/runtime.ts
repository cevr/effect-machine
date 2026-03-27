// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * Shared runtime kernel for machine event processing.
 *
 * Provides a single-queue event loop with:
 * - Sequential event processing (no split-mailbox race)
 * - Postpone buffer with drain-on-state-change (gen_statem)
 * - Background effect lifecycle
 * - Spawn effect lifecycle (per-state scope)
 * - Final state detection → stop
 * - Reply settlement (call/ask Deferreds)
 * - Reply schema validation
 *
 * Used by entity-machine. Local actor (actor.ts) has its own event loop
 * with additional concerns (inspection, listeners, subscription ref, etc.)
 * that will be migrated to use this kernel in a future refactor.
 *
 * @internal
 */
import { Deferred, Effect, Exit, Fiber, Queue, Ref, Schema, Scope, SubscriptionRef } from "effect";

import type { Machine, MachineRef } from "../machine.js";
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag } from "../actor.js";
import type { ProcessEventHooks, ProcessEventResult } from "./transition.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { processEventCore, runSpawnEffects, shouldPostpone } from "./transition.js";
import { NoReplyError } from "../errors.js";
import { INTERNAL_INIT_EVENT } from "./utils.js";

// ============================================================================
// QueuedEvent (same shape as actor.ts — event + optional reply Deferred)
// ============================================================================

/** @internal */
export type RuntimeQueuedEvent<E> =
  | { readonly _tag: "send"; readonly event: E }
  | {
      readonly _tag: "sendWait";
      readonly event: E;
      readonly done: Deferred.Deferred<void, unknown>;
    }
  | {
      readonly _tag: "ask";
      readonly event: E;
      readonly reply: Deferred.Deferred<unknown, NoReplyError>;
    };

// ============================================================================
// Runtime interface
// ============================================================================

/** @internal */
export interface RuntimeHandle<S, E> {
  /** Enqueue a fire-and-forget event */
  readonly send: (event: E) => Effect.Effect<void>;
  /** Enqueue event and wait for processing to complete (for RPC Send). Fails on defect. */
  readonly sendWait: (event: E) => Effect.Effect<void, unknown>;
  /** Enqueue an ask event, returns the reply value */
  readonly ask: (event: E) => Effect.Effect<unknown, NoReplyError>;
  /** Get current state */
  readonly getState: Effect.Effect<S>;
  /** SubscriptionRef for state observation (WatchState streaming) */
  readonly stateRef: SubscriptionRef.SubscriptionRef<S>;
  /** Whether the runtime has stopped (final state reached) */
  readonly isStopped: Effect.Effect<boolean>;
  /** Stop the runtime (interrupt event loop, clean up) */
  readonly stop: Effect.Effect<void>;
}

// ============================================================================
// Runtime creation
// ============================================================================

/** @internal */
export interface RuntimeConfig<S, E> {
  readonly actorId: string;
  readonly hooks?: ProcessEventHooks<S, E>;
  /**
   * Custom queue factory. Default: `Queue.unbounded()`.
   * Use `Queue.sliding(n)` or `Queue.dropping(n)` for bounded queues.
   */
  readonly queueFactory?: Effect.Effect<Queue.Queue<RuntimeQueuedEvent<E>>>;
}

/**
 * Create a runtime for a machine. Returns a handle for sending events
 * and querying state. The runtime owns:
 * - Single event queue (all events serialized)
 * - Event loop fiber
 * - Postpone buffer
 * - Background effects
 * - State scope (spawn effects)
 * - Final state detection
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
  const { actorId, hooks } = config;

  // State management — SubscriptionRef for WatchState streaming
  const stateRef = yield* SubscriptionRef.make<S>(machine.initial);
  const stoppedRef = yield* Ref.make(false);

  // Single event queue — all events (external RPC + internal self.send) go here
  const eventQueue = yield* config.queueFactory ?? Queue.unbounded<RuntimeQueuedEvent<E>>();

  // Pending deferred reply — stored when handler returns Machine.deferReply()
  // Settled by self.reply() from spawn handler
  const deferredReplyRef: { current: Deferred.Deferred<unknown, NoReplyError> | undefined } = {
    current: undefined,
  };

  // Self reference — sends go through the same queue
  const selfSend = Effect.fn("effect-machine.runtime.self.send")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (!stopped) {
      yield* Queue.offer(eventQueue, { _tag: "send", event });
    }
  });
  const self: MachineRef<E> = {
    send: selfSend,
    cast: selfSend,
    spawn: (childId, childMachine) =>
      system
        .spawn(`${actorId}/${childId}`, childMachine)
        .pipe(Effect.provideService(ActorSystemTag, system)),
    reply: (value: unknown) =>
      Effect.sync(() => {
        const deferred = deferredReplyRef.current;
        if (deferred !== undefined) {
          deferredReplyRef.current = undefined;
          Effect.runFork(Deferred.succeed(deferred, value));
          return true;
        }
        return false;
      }),
  };

  // State scope for spawn effects
  const stateScopeRef: { current: Scope.Closeable } = {
    current: yield* Scope.make(),
  };

  // Fork background effects
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
    const fiber = yield* Effect.forkDetach(
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
  yield* runSpawnEffects(
    machine,
    machine.initial,
    initEvent,
    self,
    stateScopeRef.current,
    system,
    actorId,
    hooks?.onError,
  );

  // Check if initial state is final
  if (machine.finalStates.has(machine.initial._tag)) {
    yield* Ref.set(stoppedRef, true);
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    return makeHandle(stateRef, stoppedRef, eventQueue, machine);
  }

  // Start event loop
  const loopFiber = yield* Effect.forkDetach(
    runtimeEventLoop(
      machine,
      stateRef,
      eventQueue,
      stoppedRef,
      self,
      backgroundFibers,
      stateScopeRef,
      actorId,
      system,
      hooks,
      deferredReplyRef,
    ),
  );

  const stop = Effect.gen(function* () {
    const alreadyStopped = yield* Ref.get(stoppedRef);
    if (alreadyStopped) return;
    yield* Ref.set(stoppedRef, true);
    yield* Fiber.interrupt(loopFiber);
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
  }).pipe(Effect.asVoid);

  // Register stop as scope finalizer so entity teardown cleans up fibers.
  // Use Effect.addFinalizer which attaches to the nearest scope in context.
  yield* Effect.addFinalizer(() => stop);

  return {
    ...makeHandle(stateRef, stoppedRef, eventQueue, machine),
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- wide acceptance
  _machine: Machine<S, E, any, any, any, any, any>,
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
        const done = yield* Deferred.make<void, unknown>();
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
  backgroundFibers: Fiber.Fiber<void, never>[],
  stateScopeRef: { current: Scope.Closeable },
  actorId: string,
  system: ActorSystem,
  hooks?: ProcessEventHooks<S, E>,
  deferredReplyRef?: { current: Deferred.Deferred<unknown, NoReplyError> | undefined },
) {
  // Postpone buffer
  const postponed: RuntimeQueuedEvent<E>[] = [];
  const hasPostponeRules = machine.postponeRules.length > 0;

  const processQueued = Effect.fn("effect-machine.runtime.processQueued")(function* (
    queued: RuntimeQueuedEvent<E>,
  ) {
    const event = queued.event;
    const currentState = yield* SubscriptionRef.get(stateRef);

    // Check postpone rules
    if (hasPostponeRules && shouldPostpone(machine, currentState._tag, event._tag)) {
      // Store as plain send for drain (the event will be re-processed later)
      postponed.push({ _tag: "send", event });
      // Settle sendWait immediately so RPC caller doesn't block
      if (queued._tag === "sendWait") {
        yield* Deferred.succeed(queued.done, undefined);
      }
      return { shouldStop: false, stateChanged: false };
    }

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

    // Settle reply/done Deferreds
    switch (queued._tag) {
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
              decoded = Schema.decodeUnknownSync(replySchema)(result.reply);
            } catch (decodeError) {
              yield* Deferred.die(queued.reply, decodeError);
              return yield* Effect.die(decodeError);
            }
            yield* Deferred.succeed(queued.reply, decoded);
          } else {
            yield* Deferred.succeed(queued.reply, result.reply);
          }
        } else if (result.deferReply && deferredReplyRef !== undefined) {
          // Handler returned Machine.deferReply() — spawn handler will call self.reply()
          deferredReplyRef.current = queued.reply;
        } else {
          yield* Deferred.fail(queued.reply, new NoReplyError({ actorId, eventTag: event._tag }));
        }
        break;
    }

    return {
      shouldStop: result.isFinal && result.lifecycleRan,
      stateChanged: result.lifecycleRan,
    };
  });

  while (true) {
    const queued = yield* Queue.take(eventQueue);
    const { shouldStop, stateChanged } = yield* processQueued(queued).pipe(
      Effect.catchCause((cause) => {
        // On defect, settle the current event's Deferred with failure so caller sees the error
        if (queued._tag === "sendWait") {
          Effect.runFork(Deferred.failCause(queued.done, cause));
        } else if (queued._tag === "ask") {
          Effect.runFork(Deferred.die(queued.reply, cause));
        }
        return Effect.failCause(cause);
      }),
    );

    if (shouldStop) {
      yield* Ref.set(stoppedRef, true);
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
        }
      }
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
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
          yield* Ref.set(stoppedRef, true);
          settlePostponed(postponed, actorId);
          const remaining2 = yield* Queue.takeAll(eventQueue);
          for (const r of remaining2) {
            if (r._tag === "sendWait") {
              Effect.runFork(Deferred.succeed(r.done, undefined));
            } else if (r._tag === "ask") {
              Effect.runFork(
                Deferred.fail(r.reply, new NoReplyError({ actorId, eventTag: r.event._tag })),
              );
            }
          }
          yield* Scope.close(stateScopeRef.current, Exit.void);
          yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
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
  postponed: RuntimeQueuedEvent<E>[],
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
  }
  postponed.length = 0;
};
