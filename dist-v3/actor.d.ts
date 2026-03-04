import { PersistentMachine } from "./persistence/persistent-machine.js";
import { DuplicateActorError } from "./errors.js";
import { EffectsDef, GuardsDef } from "./slot.js";
import {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
  processEventCore,
  resolveTransition,
  runSpawnEffects,
} from "./internal/transition.js";
import { PersistentActorRef } from "./persistence/persistent-actor.js";
import {
  ActorMetadata,
  PersistenceAdapterTag,
  PersistenceError,
  RestoreResult,
  VersionConflictError,
} from "./persistence/adapter.js";
import { BuiltMachine, Machine } from "./machine.js";
import { Effect, Option, Queue, Ref, Stream, SubscriptionRef } from "effect";

//#region src-v3/actor.d.ts
/**
 * Reference to a running actor.
 */
interface ActorRef<
  State extends {
    readonly _tag: string;
  },
  Event,
> {
  /**
   * Unique identifier for this actor
   */
  readonly id: string;
  /**
   * Send an event to the actor
   */
  readonly send: (event: Event) => Effect.Effect<void>;
  /**
   * Observable state of the actor
   */
  readonly state: SubscriptionRef.SubscriptionRef<State>;
  /**
   * Stop the actor gracefully
   */
  readonly stop: Effect.Effect<void>;
  /**
   * Stop the actor (fire-and-forget).
   * Signals graceful shutdown without waiting for completion.
   * Use when stopping from sync contexts (e.g. framework cleanup hooks).
   */
  readonly stopSync: () => void;
  /**
   * Get current state snapshot (Effect)
   */
  readonly snapshot: Effect.Effect<State>;
  /**
   * Get current state snapshot (sync)
   */
  readonly snapshotSync: () => State;
  /**
   * Check if current state matches tag (Effect)
   */
  readonly matches: (tag: State["_tag"]) => Effect.Effect<boolean>;
  /**
   * Check if current state matches tag (sync)
   */
  readonly matchesSync: (tag: State["_tag"]) => boolean;
  /**
   * Check if event can be handled in current state (Effect)
   */
  readonly can: (event: Event) => Effect.Effect<boolean>;
  /**
   * Check if event can be handled in current state (sync)
   */
  readonly canSync: (event: Event) => boolean;
  /**
   * Stream of state changes
   */
  readonly changes: Stream.Stream<State>;
  /**
   * Wait for a state that matches predicate or state variant (includes current snapshot).
   * Accepts a predicate function or a state constructor/value (e.g. `State.Active`).
   */
  readonly waitFor: {
    (predicate: (state: State) => boolean): Effect.Effect<State>;
    (state: { readonly _tag: State["_tag"] }): Effect.Effect<State>;
  };
  /**
   * Wait for a final state (includes current snapshot)
   */
  readonly awaitFinal: Effect.Effect<State>;
  /**
   * Send event and wait for predicate, state variant, or final state.
   * Accepts a predicate function or a state constructor/value (e.g. `State.Active`).
   */
  readonly sendAndWait: {
    (event: Event, predicate: (state: State) => boolean): Effect.Effect<State>;
    (
      event: Event,
      state: {
        readonly _tag: State["_tag"];
      },
    ): Effect.Effect<State>;
    (event: Event): Effect.Effect<State>;
  };
  /**
   * Send event synchronously (fire-and-forget).
   * No-op on stopped actors. Use when you need to send from sync contexts
   * (e.g. framework hooks, event handlers).
   */
  readonly sendSync: (event: Event) => void;
  /**
   * Subscribe to state changes (sync callback)
   * Returns unsubscribe function
   */
  readonly subscribe: (fn: (state: State) => void) => () => void;
  /**
   * The actor system this actor belongs to.
   * Every actor always has a system — either inherited from context or implicitly created.
   */
  readonly system: ActorSystem;
  /**
   * Child actors spawned via `self.spawn` in this actor's handlers.
   * State-scoped children are auto-removed on state exit.
   */
  readonly children: ReadonlyMap<string, ActorRef<AnyState, unknown>>;
}
/** Base type for stored actors (internal) */
type AnyState = {
  readonly _tag: string;
};
/**
 * Events emitted by the ActorSystem when actors are spawned or stopped.
 */
type SystemEvent =
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
type SystemEventListener = (event: SystemEvent) => void;
/**
 * Actor system for managing actor lifecycles
 */
interface ActorSystem {
  /**
   * Spawn a new actor with the given machine.
   *
   * For regular machines, returns ActorRef.
   * For persistent machines (created with Machine.persist), returns PersistentActorRef.
   *
   * All effect slots must be provided via `.build()` before spawning.
   *
   * @example
   * ```ts
   * // Regular machine (built)
   * const built = machine.build({ fetchData: ... })
   * const actor = yield* system.spawn("my-actor", built);
   *
   * // Persistent machine (auto-detected)
   * const persistentActor = yield* system.spawn("my-actor", persistentMachine);
   * persistentActor.persist; // available
   * persistentActor.version; // available
   * ```
   */
  readonly spawn: {
    <
      S extends {
        readonly _tag: string;
      },
      E extends {
        readonly _tag: string;
      },
      R,
    >(
      id: string,
      machine: BuiltMachine<S, E, R>,
    ): Effect.Effect<ActorRef<S, E>, DuplicateActorError, R>;
    <
      S extends {
        readonly _tag: string;
      },
      E extends {
        readonly _tag: string;
      },
      R,
    >(
      id: string,
      machine: PersistentMachine<S, E, R>,
    ): Effect.Effect<
      PersistentActorRef<S, E, R>,
      PersistenceError | VersionConflictError | DuplicateActorError,
      R | PersistenceAdapterTag
    >;
  };
  /**
   * Restore an actor from persistence.
   * Returns None if no persisted state exists for the given ID.
   *
   * @example
   * ```ts
   * const maybeActor = yield* system.restore("order-1", persistentMachine);
   * if (Option.isSome(maybeActor)) {
   *   const actor = maybeActor.value;
   *   const state = yield* actor.snapshot;
   *   console.log(`Restored to state: ${state._tag}`);
   * }
   * ```
   */
  readonly restore: <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
  >(
    id: string,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<
    Option.Option<PersistentActorRef<S, E, R>>,
    PersistenceError | DuplicateActorError,
    R | PersistenceAdapterTag
  >;
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
  /**
   * List all persisted actor metadata.
   * Returns empty array if adapter doesn't support registry.
   *
   * @example
   * ```ts
   * const actors = yield* system.listPersisted();
   * for (const meta of actors) {
   *   console.log(`${meta.id}: ${meta.stateTag} (v${meta.version})`);
   * }
   * ```
   */
  readonly listPersisted: () => Effect.Effect<
    ReadonlyArray<ActorMetadata>,
    PersistenceError,
    PersistenceAdapterTag
  >;
  /**
   * Restore multiple actors by ID.
   * Returns both successfully restored actors and failures.
   *
   * @example
   * ```ts
   * const result = yield* system.restoreMany(["order-1", "order-2"], orderMachine);
   * console.log(`Restored: ${result.restored.length}, Failed: ${result.failed.length}`);
   * ```
   */
  readonly restoreMany: <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
  >(
    ids: ReadonlyArray<string>,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<RestoreResult<S, E, R>, never, R | PersistenceAdapterTag>;
  /**
   * Restore all persisted actors for a machine type.
   * Uses adapter registry if available, otherwise returns empty result.
   *
   * @example
   * ```ts
   * const result = yield* system.restoreAll(orderMachine, {
   *   filter: (meta) => meta.stateTag !== "Done"
   * });
   * console.log(`Restored ${result.restored.length} active orders`);
   * ```
   */
  readonly restoreAll: <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
  >(
    machine: PersistentMachine<S, E, R>,
    options?: {
      filter?: (meta: ActorMetadata) => boolean;
    },
  ) => Effect.Effect<RestoreResult<S, E, R>, PersistenceError, R | PersistenceAdapterTag>;
}
/**
 * ActorSystem service tag
 */
declare const ActorSystem: any;
/** Listener set for sync subscriptions */
type Listeners<S> = Set<(state: S) => void>;
/**
 * Notify all listeners of state change.
 */
declare const notifyListeners: <S>(listeners: Listeners<S>, state: S) => void;
/**
 * Build core ActorRef methods shared between regular and persistent actors.
 */
declare const buildActorRefCore: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateRef: SubscriptionRef.SubscriptionRef<S>,
  eventQueue: Queue.Queue<E>,
  stoppedRef: Ref.Ref<boolean>,
  listeners: Listeners<S>,
  stop: Effect.Effect<void>,
  system: ActorSystem,
  childrenMap: ReadonlyMap<string, ActorRef<AnyState, unknown>>,
) => ActorRef<S, E>;
/**
 * Create and start an actor for a machine
 */
declare const createActor: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  id: string,
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
) => Effect.Effect<ActorRef<S, E>, unknown, unknown>;
/**
 * Default ActorSystem layer
 */
declare const Default: any;
//#endregion
export {
  ActorRef,
  ActorSystem,
  Default,
  Listeners,
  type ProcessEventError,
  type ProcessEventHooks,
  type ProcessEventResult,
  SystemEvent,
  SystemEventListener,
  buildActorRefCore,
  createActor,
  notifyListeners,
  processEventCore,
  resolveTransition,
  runSpawnEffects,
};
