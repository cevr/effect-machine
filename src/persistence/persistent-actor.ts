// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics anyUnknownInErrorContext:off

import { Clock, Effect, Fiber, Option, Queue, Ref, SubscriptionRef } from "effect";

import type { ActorRef, Listeners } from "../actor.js";
import { buildActorRefCore, notifyListeners } from "../actor.js";
import type { MachineRef, HandlerContext, Machine } from "../machine.js";
import type { Inspector } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import { resolveTransition } from "../internal/transition.js";
import { isEffect } from "../internal/utils.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";

import type {
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  PersistenceError,
  Snapshot,
  VersionConflictError,
} from "./adapter.js";
import { PersistenceAdapterTag } from "./adapter.js";
import type { PersistentMachine } from "./persistent-machine.js";

/**
 * Extended ActorRef with persistence capabilities
 */
export interface PersistentActorRef<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
> extends ActorRef<S, E> {
  /**
   * Force an immediate snapshot save
   */
  readonly persist: Effect.Effect<void, PersistenceError | VersionConflictError>;

  /**
   * Get the current persistence version
   */
  readonly version: Effect.Effect<number>;

  /**
   * Replay events to restore actor to a specific version.
   * Note: This only computes state; does not re-run transition effects.
   */
  readonly replayTo: (version: number) => Effect.Effect<void, PersistenceError>;
}

/** Get current time in milliseconds using Effect Clock */
const now = Clock.currentTimeMillis;

/**
 * Build PersistentActorRef with all methods
 */
const buildPersistentActorRef = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  versionRef: Ref.Ref<number>,
  eventQueue: Queue.Queue<E>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
  adapter: PersistenceAdapter,
): PersistentActorRef<S, E> => {
  const { machine, persistence } = persistentMachine;
  const typedMachine = machine as unknown as Machine<
    S,
    E,
    R,
    Record<string, never>,
    Record<string, never>,
    GD,
    EFD
  >;

  const persist: Effect.Effect<void, PersistenceError | VersionConflictError> = Effect.gen(
    function* () {
      const state = yield* SubscriptionRef.get(stateRef);
      const version = yield* Ref.get(versionRef);
      const timestamp = yield* now;
      const snapshot: Snapshot<S> = {
        state,
        version,
        timestamp,
      };
      yield* adapter.saveSnapshot(id, snapshot, persistence.stateSchema);
    },
  );

  // Replay only computes state synchronously - doesn't run transition effects
  const replayTo = (targetVersion: number): Effect.Effect<void, PersistenceError> =>
    Effect.gen(function* () {
      const currentVersion = yield* Ref.get(versionRef);
      if (targetVersion <= currentVersion) {
        // Load snapshot at or before target, then replay events
        const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);
        if (Option.isSome(maybeSnapshot)) {
          const snapshot = maybeSnapshot.value;
          if (snapshot.version <= targetVersion) {
            // Apply events from snapshot version to target version
            const events = yield* adapter.loadEvents(id, persistence.eventSchema, snapshot.version);
            let state = snapshot.state;
            let version = snapshot.version;

            // Dummy self for slot accessors
            const dummySelf: MachineRef<E> = {
              send: () => Effect.void,
            };

            for (const persistedEvent of events) {
              if (persistedEvent.version > targetVersion) break;

              const transition = resolveTransition(typedMachine, state, persistedEvent.event);
              if (transition !== undefined) {
                // Create context for handler
                const ctx: MachineContext<S, E, MachineRef<E>> = {
                  state,
                  event: persistedEvent.event,
                  self: dummySelf,
                };
                const { guards, effects } = typedMachine._createSlotAccessors(ctx);

                const handlerCtx: HandlerContext<S, E, GD, EFD> = {
                  state,
                  event: persistedEvent.event,
                  guards,
                  effects,
                };

                const newStateResult = transition.handler(handlerCtx);
                // Only support synchronous handlers in replay
                if (!isEffect(newStateResult)) {
                  state = newStateResult;
                }
              }
              version = persistedEvent.version;
            }

            yield* SubscriptionRef.set(stateRef, state);
            yield* Ref.set(versionRef, version);
            notifyListeners(listeners, state);
          }
        }
      }
    });

  const core = buildActorRefCore(id, typedMachine, stateRef, eventQueue, listeners, stop);

  return {
    ...core,
    persist,
    version: Ref.get(versionRef),
    replayTo,
  };
};

/**
 * Create a persistent actor from a PersistentMachine.
 * Restores from existing snapshot if available, otherwise starts fresh.
 */
export const createPersistentActor = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  initialSnapshot: Option.Option<Snapshot<S>>,
  initialEvents: ReadonlyArray<PersistedEvent<E>>,
): Effect.Effect<PersistentActorRef<S, E>, PersistenceError, R | PersistenceAdapterTag> =>
  Effect.withSpan("effect-machine.persistent-actor.spawn", {
    attributes: { "effect_machine.actor.id": id },
  })(
    Effect.gen(function* () {
      const adapter = yield* PersistenceAdapterTag;
      const { machine } = persistentMachine;
      const typedMachine = machine as unknown as Machine<
        S,
        E,
        R,
        Record<string, never>,
        Record<string, never>,
        GD,
        EFD
      >;

      // Get optional inspector from context
      const inspectorOption = yield* Effect.serviceOption(InspectorTag);
      const inspector =
        inspectorOption._tag === "Some" ? (inspectorOption.value as Inspector<S, E>) : undefined;

      // Create self reference for sending events
      const eventQueue = yield* Queue.unbounded<E>();
      const self: MachineRef<E> = {
        send: (event) => Queue.offer(eventQueue, event),
      };

      // Determine initial state and version
      let resolvedInitial: S;
      let initialVersion: number;

      if (Option.isSome(initialSnapshot)) {
        // Restore from snapshot
        resolvedInitial = initialSnapshot.value.state;
        initialVersion = initialSnapshot.value.version;

        // Replay events after snapshot (synchronous state computation only)
        for (const persistedEvent of initialEvents) {
          const transition = resolveTransition(typedMachine, resolvedInitial, persistedEvent.event);
          if (transition !== undefined) {
            // Create context for handler
            const ctx: MachineContext<S, E, MachineRef<E>> = {
              state: resolvedInitial,
              event: persistedEvent.event,
              self,
            };
            const { guards, effects } = typedMachine._createSlotAccessors(ctx);

            const handlerCtx: HandlerContext<S, E, GD, EFD> = {
              state: resolvedInitial,
              event: persistedEvent.event,
              guards,
              effects,
            };

            const newStateResult = transition.handler(handlerCtx);
            // Support both sync and async handlers during initial restore
            const newState = isEffect(newStateResult)
              ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
                  Effect.provideService(typedMachine.Context, ctx),
                )
              : newStateResult;
            resolvedInitial = newState;
            initialVersion = persistedEvent.version;
          }
        }
      } else {
        // Fresh start
        resolvedInitial = typedMachine.initial;
        initialVersion = 0;
      }

      // Initialize state refs
      const stateRef = yield* SubscriptionRef.make(resolvedInitial);
      const versionRef = yield* Ref.make(initialVersion);
      const listeners: Listeners<S> = new Set();

      // Track creation time for metadata - prefer existing metadata if restoring
      let createdAt: number;
      if (Option.isSome(initialSnapshot)) {
        // Restoring - try to get original createdAt from metadata
        const existingMeta =
          adapter.loadMetadata !== undefined
            ? yield* adapter.loadMetadata(id)
            : Option.none<ActorMetadata>();
        createdAt = Option.isSome(existingMeta)
          ? existingMeta.value.createdAt
          : initialSnapshot.value.timestamp; // fallback to snapshot time
      } else {
        createdAt = yield* now;
      }

      // Emit spawn event
      if (inspector !== undefined) {
        const timestamp = yield* now;
        inspector.onInspect({
          type: "@machine.spawn",
          actorId: id,
          initialState: resolvedInitial,
          timestamp,
        });
      }

      // Save initial metadata
      yield* saveMetadata(
        id,
        resolvedInitial,
        initialVersion,
        createdAt,
        persistentMachine.persistence,
        adapter,
      );

      // Check if initial state is final
      if (typedMachine.finalStates.has(resolvedInitial._tag)) {
        if (inspector !== undefined) {
          const timestamp = yield* now;
          inspector.onInspect({
            type: "@machine.stop",
            actorId: id,
            finalState: resolvedInitial,
            timestamp,
          });
        }
        return buildPersistentActorRef(
          id,
          persistentMachine,
          stateRef,
          versionRef,
          eventQueue,
          listeners,
          Queue.shutdown(eventQueue).pipe(Effect.asVoid),
          adapter,
        );
      }

      // Start the persistent event loop
      const loopFiber = yield* Effect.fork(
        persistentEventLoop(
          id,
          persistentMachine,
          stateRef,
          versionRef,
          eventQueue,
          self,
          listeners,
          adapter,
          createdAt,
          inspector,
        ),
      );

      return buildPersistentActorRef(
        id,
        persistentMachine,
        stateRef,
        versionRef,
        eventQueue,
        listeners,
        Effect.gen(function* () {
          const finalState = yield* SubscriptionRef.get(stateRef);
          if (inspector !== undefined) {
            const timestamp = yield* now;
            inspector.onInspect({
              type: "@machine.stop",
              actorId: id,
              finalState,
              timestamp,
            });
          }
          yield* Queue.shutdown(eventQueue);
          yield* Fiber.interrupt(loopFiber);
        }).pipe(Effect.asVoid),
        adapter,
      );
    }),
  );

/**
 * Main event loop for persistent actor
 */
const persistentEventLoop = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  versionRef: Ref.Ref<number>,
  eventQueue: Queue.Queue<E>,
  self: MachineRef<E>,
  listeners: Listeners<S>,
  adapter: PersistenceAdapter,
  createdAt: number,
  inspector?: Inspector<S, E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const { machine, persistence } = persistentMachine;
    const typedMachine = machine as unknown as Machine<
      S,
      E,
      R,
      Record<string, never>,
      Record<string, never>,
      GD,
      EFD
    >;

    while (true) {
      const event = yield* Queue.take(eventQueue);
      const currentState = yield* SubscriptionRef.get(stateRef);
      const currentVersion = yield* Ref.get(versionRef);

      // Emit event received
      if (inspector !== undefined) {
        const timestamp = yield* now;
        inspector.onInspect({
          type: "@machine.event",
          actorId: id,
          state: currentState,
          event,
          timestamp,
        });
      }

      // Find matching transition
      const transition = resolveTransition(typedMachine, currentState, event);
      if (transition === undefined) {
        continue;
      }

      // Increment version
      const newVersion = currentVersion + 1;
      yield* Ref.set(versionRef, newVersion);

      // Journal event if enabled
      if (persistence.journalEvents) {
        const timestamp = yield* now;
        const persistedEvent: PersistedEvent<E> = {
          event,
          version: newVersion,
          timestamp,
        };
        yield* adapter
          .appendEvent(id, persistedEvent, persistence.eventSchema)
          .pipe(
            Effect.catchAll((e) => Effect.logWarning(`Failed to journal event for actor ${id}`, e)),
          );
      }

      // Create context for handler
      const ctx: MachineContext<S, E, MachineRef<E>> = {
        state: currentState,
        event,
        self,
      };
      const { guards, effects } = typedMachine._createSlotAccessors(ctx);

      const handlerCtx: HandlerContext<S, E, GD, EFD> = {
        state: currentState,
        event,
        guards,
        effects,
      };

      // Compute new state
      const newStateResult = transition.handler(handlerCtx);
      let newState = isEffect(newStateResult)
        ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
            Effect.provideService(typedMachine.Context, ctx),
          )
        : newStateResult;

      // Determine if we should run exit/enter effects
      const stateTagChanged = newState._tag !== currentState._tag;
      const runLifecycle = stateTagChanged || transition.reenter === true;

      if (runLifecycle) {
        // Note: Spawn effects cancelled automatically when we exit state
        // (persistent actors don't use spawn effects for now)

        // Emit transition event
        if (inspector !== undefined) {
          const timestamp = yield* now;
          inspector.onInspect({
            type: "@machine.transition",
            actorId: id,
            fromState: currentState,
            toState: newState,
            event,
            timestamp,
          });
        }

        // Update state
        yield* SubscriptionRef.set(stateRef, newState);
        notifyListeners(listeners, newState);

        // Save snapshot (after state and version are both updated)
        yield* saveSnapshot(id, newState, newVersion, persistence, adapter);

        // Update metadata
        yield* saveMetadata(id, newState, newVersion, createdAt, persistence, adapter);

        // Note: Spawn effects not implemented for persistent actors yet
        // (would need to re-fork on replay)

        // Check if final
        if (typedMachine.finalStates.has(newState._tag)) {
          if (inspector !== undefined) {
            const timestamp = yield* now;
            inspector.onInspect({
              type: "@machine.stop",
              actorId: id,
              finalState: newState,
              timestamp,
            });
          }
          notifyListeners(listeners, newState);
          return;
        }
      } else {
        yield* SubscriptionRef.set(stateRef, newState);
        notifyListeners(listeners, newState);

        // Save snapshot (after state and version are both updated)
        yield* saveSnapshot(id, newState, newVersion, persistence, adapter);

        // Update metadata
        yield* saveMetadata(id, newState, newVersion, createdAt, persistence, adapter);
      }
    }
  });

/**
 * Save a snapshot after state transition.
 * Called inline in event loop to avoid race conditions.
 */
const saveSnapshot = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  id: string,
  state: S,
  version: number,
  persistence: PersistentMachine<S, E, never>["persistence"],
  adapter: PersistenceAdapter,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const timestamp = yield* now;
    const snapshot: Snapshot<S> = {
      state,
      version,
      timestamp,
    };
    yield* adapter
      .saveSnapshot(id, snapshot, persistence.stateSchema)
      .pipe(
        Effect.catchAll((e) => Effect.logWarning(`Failed to save snapshot for actor ${id}`, e)),
      );
  });

/**
 * Save or update actor metadata if adapter supports registry.
 * Called on spawn and state transitions.
 */
const saveMetadata = <S extends { readonly _tag: string }, E extends { readonly _tag: string }>(
  id: string,
  state: S,
  version: number,
  createdAt: number,
  persistence: PersistentMachine<S, E, never>["persistence"],
  adapter: PersistenceAdapter,
): Effect.Effect<void> => {
  const save = adapter.saveMetadata;
  if (save === undefined) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const lastActivityAt = yield* now;
    const metadata: ActorMetadata = {
      id,
      machineType: persistence.machineType ?? "unknown",
      createdAt,
      lastActivityAt,
      version,
      stateTag: state._tag,
    };
    yield* save(metadata).pipe(
      Effect.catchAll((e) => Effect.logWarning(`Failed to save metadata for actor ${id}`, e)),
    );
  });
};

/**
 * Restore an actor from persistence.
 * Returns None if no persisted state exists.
 */
export const restorePersistentActor = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
): Effect.Effect<
  Option.Option<PersistentActorRef<S, E>>,
  PersistenceError,
  R | PersistenceAdapterTag
> =>
  Effect.gen(function* () {
    const adapter = yield* PersistenceAdapterTag;
    const { persistence } = persistentMachine;

    // Try to load snapshot
    const maybeSnapshot = yield* adapter.loadSnapshot(id, persistence.stateSchema);

    if (Option.isNone(maybeSnapshot)) {
      return Option.none();
    }

    // Load events after snapshot
    const events = yield* adapter.loadEvents(
      id,
      persistence.eventSchema,
      maybeSnapshot.value.version,
    );

    // Create actor with restored state
    const actor = yield* createPersistentActor(id, persistentMachine, maybeSnapshot, events);

    return Option.some(actor);
  });
