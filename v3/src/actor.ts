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
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import type { Machine, MachineRef, BuiltMachine } from "./machine.js";
import type { ReplyTypeBrand, ExtractReply } from "./internal/brands.js";
import type { Inspector } from "./inspection.js";
import { Inspector as InspectorTag } from "./inspection.js";
import {
  processEventCore,
  runSpawnEffects,
  resolveTransition,
  shouldPostpone,
} from "./internal/transition.js";
import type {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
} from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";

// Re-export for external use (cluster, persistence)
export { resolveTransition, runSpawnEffects, processEventCore } from "./internal/transition.js";
export type {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
} from "./internal/transition.js";

// ============================================================================
// QueuedEvent (internal wrapper for event queue)
// ============================================================================

/** Discriminated mailbox request */
export type QueuedEvent<E> =
  | { readonly _tag: "send"; readonly event: E }
  | {
      readonly _tag: "call";
      readonly event: E;
      readonly reply: Deferred.Deferred<
        ProcessEventResult<{ readonly _tag: string }>,
        ActorStoppedError
      >;
    }
  | {
      readonly _tag: "ask";
      readonly event: E;
      readonly reply: Deferred.Deferred<unknown, NoReplyError | ActorStoppedError>;
    };
import type { GuardsDef, EffectsDef } from "./slot.js";
import { DuplicateActorError, ActorStoppedError, NoReplyError } from "./errors.js";
import { INTERNAL_INIT_EVENT } from "./internal/utils.js";

// ============================================================================
// ActorRef Interface
// ============================================================================

/**
 * Reference to a running actor.
 */
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
 * Build core ActorRef methods shared between regular and persistent actors.
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
    yield* Queue.offer(eventQueue, { _tag: "call", event, reply });
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
    yield* Queue.offer(eventQueue, { _tag: "ask", event, reply });
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
    const rt = yield* Effect.runtime<never>();
    const runFork = Runtime.runFork(rt);
    const listener = (state: S) => {
      if (predicate(state)) {
        runFork(Deferred.succeed(done, state));
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
// Actor Creation and Event Loop
// ============================================================================

/**
 * Create and start an actor for a machine
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

  // Create self reference for sending events
  const eventQueue = yield* Queue.unbounded<QueuedEvent<E>>();
  const stoppedRef = yield* Ref.make(false);
  const childrenMap = new Map<string, ActorRef<AnyState, unknown>>();
  const selfSend = Effect.fn("effect-machine.actor.self.send")(function* (event: E) {
    const stopped = yield* Ref.get(stoppedRef);
    if (stopped) {
      return;
    }
    yield* Queue.offer(eventQueue, { _tag: "send", event });
  });
  const self: MachineRef<E> = {
    send: selfSend,
    cast: selfSend,
    spawn: (childId, childMachine) =>
      Effect.gen(function* () {
        const child = yield* system
          .spawn(childId, childMachine)
          .pipe(Effect.provideService(ActorSystem, system));
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
        return child;
      }),
  };

  // Annotate span with initial state
  yield* Effect.annotateCurrentSpan("effect_machine.actor.initial_state", initial._tag);

  // Emit spawn event
  yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
    type: "@machine.spawn",
    actorId: id,
    initialState: initial,
    timestamp,
  }));

  // Initialize state
  const stateRef = yield* SubscriptionRef.make(initial);
  const listeners: Listeners<S> = new Set();

  // Fork background effects (run for entire machine lifetime)
  const backgroundFibers: Fiber.Fiber<void, never>[] = [];
  const initEvent = { _tag: INTERNAL_INIT_EVENT } as E;
  const ctx = { actorId: id, state: initial, event: initEvent, self, system };
  const { effects: effectSlots } = machine._slots;

  for (const bg of machine.backgroundEffects) {
    const fiber = yield* Effect.forkDaemon(
      bg
        .handler({
          actorId: id,
          state: initial,
          event: initEvent,
          self,
          effects: effectSlots,
          system,
        })
        .pipe(Effect.provideService(machine.Context, ctx)),
    );
    backgroundFibers.push(fiber);
  }

  // Create state scope for initial state's spawn effects
  const stateScopeRef: { current: Scope.CloseableScope } = {
    current: yield* Scope.make(),
  };

  // Run spawn effects for the current state (whether fresh or hydrated).
  // Spawn effects install live machinery (timers, scoped resources) that
  // the state needs at runtime — they must re-run on hydration.
  yield* runSpawnEffectsWithInspection(
    machine,
    initial,
    initEvent,
    self,
    stateScopeRef.current,
    id,
    inspectorValue,
    system,
  );

  // Check if initial state (after always) is final
  if (machine.finalStates.has(initial._tag)) {
    // Close state scope and interrupt background effects
    yield* Scope.close(stateScopeRef.current, Exit.void);
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
      type: "@machine.stop",
      actorId: id,
      finalState: initial,
      timestamp,
    }));
    yield* Ref.set(stoppedRef, true);
    if (implicitSystemScope !== undefined) {
      yield* Scope.close(implicitSystemScope, Exit.void);
    }
    const stop = Ref.set(stoppedRef, true).pipe(
      Effect.withSpan("effect-machine.actor.stop"),
      Effect.asVoid,
    );
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
      new Set(),
    );
  }

  // Pending reply tracking — registered before enqueue, settled on stop
  const pendingReplies = new Set<Deferred.Deferred<unknown, unknown>>();

  // PubSub for transition observation (actor.transitions stream)
  const transitionsPubSub = yield* PubSub.unbounded<TransitionInfo<S, E>>();

  // Start the event loop — use forkDaemon so the event loop fiber's lifetime
  // is detached from any parent scope/fiber. actor.stop handles cleanup.
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
      pendingReplies,
      transitionsPubSub,
    ),
  );

  const stop = Effect.gen(function* () {
    const finalState = yield* SubscriptionRef.get(stateRef);
    yield* emitWithTimestamp(inspectorValue, (timestamp) => ({
      type: "@machine.stop",
      actorId: id,
      finalState,
      timestamp,
    }));
    yield* Ref.set(stoppedRef, true);
    yield* Fiber.interrupt(loopFiber);
    // Fail all pending call/ask Deferreds
    yield* settlePendingReplies(pendingReplies, id);
    // Close state scope (interrupts spawn fibers)
    yield* Scope.close(stateScopeRef.current, Exit.void);
    // Interrupt background effects (in parallel)
    yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
    // If this actor created an implicit system, tear it down (stops all children)
    if (implicitSystemScope !== undefined) {
      yield* Scope.close(implicitSystemScope, Exit.void);
    }
  }).pipe(Effect.withSpan("effect-machine.actor.stop"), Effect.asVoid);

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

/**
 * Main event loop for the actor.
 * Includes postpone buffer — events matching postpone rules are buffered
 * and drained after state tag changes (gen_statem semantics).
 */
const eventLoop = Effect.fn("effect-machine.actor.eventLoop")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<QueuedEvent<E>>,
  stoppedRef: Ref.Ref<boolean>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  backgroundFibers: Fiber.Fiber<void, never>[],
  stateScopeRef: { current: Scope.CloseableScope },
  actorId: string,
  inspector: Inspector<S, E> | undefined,
  system: ActorSystem,
  pendingReplies: Set<Deferred.Deferred<unknown, unknown>>,
  transitionsPubSub: PubSub.PubSub<TransitionInfo<S, E>>,
) {
  // Postpone buffer — events deferred for retry after next state change
  const postponed: QueuedEvent<E>[] = [];
  const hasPostponeRules = machine.postponeRules.length > 0;

  // Process a single queued event: check postpone, run transition, settle reply
  const processQueued = Effect.fn("effect-machine.actor.processQueued")(function* (
    queued: QueuedEvent<E>,
  ) {
    const event = queued.event;
    const currentState = yield* SubscriptionRef.get(stateRef);

    // Check postpone rules before processing
    if (hasPostponeRules && shouldPostpone(machine, currentState._tag, event._tag)) {
      postponed.push(queued);
      if (queued._tag === "call") {
        const postponedResult: ProcessEventResult<S> = {
          newState: currentState,
          previousState: currentState,
          transitioned: false,
          lifecycleRan: false,
          isFinal: false,
          hasReply: false,
          reply: undefined,
          postponed: true,
        };
        yield* Deferred.succeed(queued.reply, postponedResult);
      }
      return { shouldStop: false, stateChanged: false };
    }

    const { shouldStop, result } = yield* Effect.withSpan("effect-machine.event.process", {
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
    );

    // Settle reply based on request type
    switch (queued._tag) {
      case "call":
        yield* Deferred.succeed(queued.reply, result);
        break;
      case "ask": {
        if (result.hasReply) {
          // Runtime validation: decode reply through event's reply schema
          const replySchema = machine._replySchemas?.get(event._tag);
          if (replySchema !== undefined) {
            // Decode failure = defect (broken handler). Settle deferred before dying
            // so the ask caller sees the error instead of hanging forever.
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
    }

    // Publish transition info for observers (actor.transitions stream)
    if (result.transitioned) {
      yield* PubSub.publish(transitionsPubSub, {
        fromState: result.previousState,
        toState: result.newState,
        event,
      });
    }

    return { shouldStop, stateChanged: result.lifecycleRan };
  });

  while (true) {
    const queued = yield* Queue.take(eventQueue);
    const { shouldStop, stateChanged } = yield* processQueued(queued);

    if (shouldStop) {
      yield* Ref.set(stoppedRef, true);
      settlePostponedBuffer(postponed, pendingReplies, actorId);
      yield* settlePendingReplies(pendingReplies, actorId);
      yield* Scope.close(stateScopeRef.current, Exit.void);
      yield* Effect.all(backgroundFibers.map(Fiber.interrupt), { concurrency: "unbounded" });
      return;
    }

    // Drain postponed events with priority — loop until stable
    let drainTriggered = stateChanged;
    while (drainTriggered && postponed.length > 0) {
      drainTriggered = false;
      const drained = postponed.splice(0);
      for (const entry of drained) {
        const drain = yield* processQueued(entry);
        if (drain.shouldStop) {
          yield* Ref.set(stoppedRef, true);
          settlePostponedBuffer(postponed, pendingReplies, actorId);
          yield* settlePendingReplies(pendingReplies, actorId);
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

/**
 * Settle all reply-bearing entries in the postpone buffer on shutdown.
 * Call entries already had their Deferred settled with the postponed result
 * (so their pendingReplies entry is already removed). Ask/send entries
 * with Deferreds are settled via the pendingReplies registry.
 */
const settlePostponedBuffer = <E>(
  postponed: QueuedEvent<E>[],
  _pendingReplies: Set<Deferred.Deferred<unknown, unknown>>,
  _actorId: string,
): void => {
  // Clear the buffer — remaining Deferreds are settled via pendingReplies
  postponed.length = 0;
};

/**
 * Process a single event, returning true if the actor should stop.
 * Wraps processEventCore with actor-specific concerns (inspection, listeners, state ref).
 */
const processEvent = Effect.fn("effect-machine.actor.processEvent")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  stateScopeRef: { current: Scope.CloseableScope },
  actorId: string,
  inspector: Inspector<S, E> | undefined,
  system: ActorSystem,
) {
  // Emit event received
  yield* emitWithTimestamp(inspector, (timestamp) => ({
    type: "@machine.event",
    actorId,
    state: currentState,
    event,
    timestamp,
  }));

  // Build inspection hooks for processEventCore
  const hooks: ProcessEventHooks<S, E> | undefined =
    inspector === undefined
      ? undefined
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
        };

  // Process event using shared core
  const result = yield* processEventCore(
    machine,
    currentState,
    event,
    self,
    stateScopeRef,
    system,
    actorId,
    hooks,
  );

  if (!result.transitioned) {
    yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", false);
    return { shouldStop: false, result };
  }

  yield* Effect.annotateCurrentSpan("effect_machine.transition.matched", true);

  // Update state ref and notify listeners
  yield* SubscriptionRef.set(stateRef, result.newState);
  notifyListeners(listeners, result.newState);

  if (result.lifecycleRan) {
    yield* Effect.annotateCurrentSpan("effect_machine.state.from", result.previousState._tag);
    yield* Effect.annotateCurrentSpan("effect_machine.state.to", result.newState._tag);

    // Transition inspection event emitted via hooks in processEventCore

    // Check if new state is final
    if (result.isFinal) {
      yield* emitWithTimestamp(inspector, (timestamp) => ({
        type: "@machine.stop",
        actorId,
        finalState: result.newState,
        timestamp,
      }));
      return { shouldStop: true, result };
    }
  }

  return { shouldStop: false, result };
});

/**
 * Run spawn effects with actor-specific inspection and tracing.
 * Wraps the core runSpawnEffects with inspection events and spans.
 * @internal
 */
const runSpawnEffectsWithInspection = Effect.fn("effect-machine.actor.spawnEffects")(function* <
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
  inspector: Inspector<S, E> | undefined,
  system: ActorSystem,
) {
  // Emit inspection event before running effects
  yield* emitWithTimestamp(inspector, (timestamp) => ({
    type: "@machine.effect",
    actorId,
    effectType: "spawn",
    state,
    timestamp,
  }));

  // Use shared core
  const onError =
    inspector === undefined
      ? undefined
      : (info: ProcessEventError<S, E>) =>
          emitWithTimestamp(inspector, (timestamp) => ({
            type: "@machine.error",
            actorId,
            phase: info.phase,
            state: info.state,
            event: info.event,
            error: Cause.pretty(info.cause),
            timestamp,
          }));

  yield* runSpawnEffects(machine, state, event, self, stateScope, system, actorId, onError);
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
 * Default ActorSystem layer
 */
export const Default = Layer.scoped(ActorSystem, make());
