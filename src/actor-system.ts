import { Context, Effect, Layer, Option, SynchronizedRef } from "effect";
import type { Scope } from "effect";

import type { ActorRef } from "./actor-ref.js";
import type { Machine } from "./machine.js";
import { createActor } from "./internal/loop.js";
import type { GuardsDef, EffectsDef } from "./slot.js";
import { DuplicateActorError, UnprovidedSlotsError } from "./errors.js";
import type {
  ActorMetadata,
  PersistenceError,
  RestoreResult,
  VersionConflictError,
} from "./persistence/adapter.js";
import {
  PersistenceAdapterTag,
  PersistenceError as PersistenceErrorClass,
} from "./persistence/adapter.js";
import type { PersistentMachine } from "./persistence/persistent-machine.js";
import { isPersistentMachine } from "./persistence/persistent-machine.js";
import type { PersistentActorRef } from "./persistence/persistent-actor.js";
import { createPersistentActor, restorePersistentActor } from "./persistence/persistent-actor.js";

/** Base type for stored actors (internal) */
type AnyState = { readonly _tag: string };

/**
 * Actor system for managing actor lifecycles
 */
export interface ActorSystem {
  /**
   * Spawn a new actor with the given machine.
   *
   * For regular machines, returns ActorRef.
   * For persistent machines (created with Machine.persist), returns PersistentActorRef.
   *
   * Note: All effect slots must be provided via `Machine.provide` before spawning.
   * Attempting to spawn a machine with unprovided effect slots will fail.
   *
   * @example
   * ```ts
   * // Regular machine (effects provided)
   * const machine = Machine.provide(baseMachine, { fetchData: ... })
   * const actor = yield* system.spawn("my-actor", machine);
   *
   * // Persistent machine (auto-detected)
   * const persistentActor = yield* system.spawn("my-actor", persistentMachine);
   * persistentActor.persist; // available
   * persistentActor.version; // available
   * ```
   */
  readonly spawn: {
    // Regular machine overload - Effects must be never (all provided)
    <
      S extends { readonly _tag: string },
      E extends { readonly _tag: string },
      R,
      GD extends GuardsDef = Record<string, never>,
      EFD extends EffectsDef = Record<string, never>,
    >(
      id: string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
      machine: Machine<S, E, R, never, any, any, GD, EFD>,
    ): Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope>;

    // Persistent machine overload
    <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
      id: string,
      machine: PersistentMachine<S, E, R>,
    ): Effect.Effect<
      PersistentActorRef<S, E>,
      PersistenceError | VersionConflictError,
      R | Scope.Scope | PersistenceAdapterTag
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
  readonly restore: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<
    Option.Option<PersistentActorRef<S, E>>,
    PersistenceError,
    R | Scope.Scope | PersistenceAdapterTag
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
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    ids: ReadonlyArray<string>,
    machine: PersistentMachine<S, E, R>,
  ) => Effect.Effect<RestoreResult<S, E>, never, R | Scope.Scope | PersistenceAdapterTag>;

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
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    machine: PersistentMachine<S, E, R>,
    options?: { filter?: (meta: ActorMetadata) => boolean },
  ) => Effect.Effect<
    RestoreResult<S, E>,
    PersistenceError,
    R | Scope.Scope | PersistenceAdapterTag
  >;
}

/**
 * ActorSystem service tag
 */
export const ActorSystem = Context.GenericTag<ActorSystem>("@effect/machine/ActorSystem");

/**
 * Internal implementation
 */
const make = Effect.gen(function* () {
  const actors = yield* SynchronizedRef.make(new Map<string, ActorRef<AnyState, unknown>>());

  /** Check for duplicate ID, register actor, add cleanup finalizer */
  const registerActor = <T extends { stop: Effect.Effect<void> }>(
    id: string,
    actor: T,
  ): Effect.Effect<T, never, Scope.Scope> =>
    Effect.gen(function* () {
      // Check if actor already exists
      const existing = yield* SynchronizedRef.get(actors);
      if (existing.has(id)) {
        throw new DuplicateActorError({ actorId: id });
      }

      // Register it
      yield* SynchronizedRef.update(actors, (map) => {
        const newMap = new Map(map);
        newMap.set(id, actor as unknown as ActorRef<AnyState, unknown>);
        return newMap;
      });

      // Register cleanup on scope finalization
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* actor.stop;
          yield* SynchronizedRef.update(actors, (map) => {
            const newMap = new Map(map);
            newMap.delete(id);
            return newMap;
          });
        }),
      );

      return actor;
    });

  const spawnRegular = <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  ): Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope> =>
    Effect.gen(function* () {
      // Validate all effect slots are provided (runtime safety net)
      if (machine.effectSlots.size > 0) {
        const unprovided = Array.from(machine.effectSlots.keys());
        throw new UnprovidedSlotsError({ slots: unprovided });
      }

      // Create and register the actor
      // Cast to the expected type for createActor
      const actor = yield* createActor(
        id,
        machine as unknown as Machine<
          S,
          E,
          R,
          never,
          Record<string, never>,
          Record<string, never>,
          GD,
          EFD
        >,
      );
      return yield* registerActor(id, actor);
    });

  const spawnPersistent = <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
  >(
    id: string,
    persistentMachine: PersistentMachine<S, E, R>,
  ): Effect.Effect<
    PersistentActorRef<S, E>,
    PersistenceError | VersionConflictError,
    R | Scope.Scope | PersistenceAdapterTag
  > =>
    Effect.gen(function* () {
      const adapter = yield* PersistenceAdapterTag;

      // Try to load existing snapshot
      const maybeSnapshot = yield* adapter.loadSnapshot(
        id,
        persistentMachine.persistence.stateSchema,
      );

      // Load events after snapshot (if any)
      const events = Option.isSome(maybeSnapshot)
        ? yield* adapter.loadEvents(
            id,
            persistentMachine.persistence.eventSchema,
            maybeSnapshot.value.version,
          )
        : [];

      // Create and register the persistent actor
      const actor = yield* createPersistentActor(id, persistentMachine, maybeSnapshot, events);
      return yield* registerActor(id, actor);
    });

  // Type-safe overloaded spawn implementation
  function spawn<
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine: Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
  ): Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope>;
  function spawn<S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: PersistentMachine<S, E, R>,
  ): Effect.Effect<
    PersistentActorRef<S, E>,
    PersistenceError | VersionConflictError,
    R | Scope.Scope | PersistenceAdapterTag
  >;
  function spawn<
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(
    id: string,
    machine:
      | Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>
      | PersistentMachine<S, E, R>,
  ):
    | Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope>
    | Effect.Effect<
        PersistentActorRef<S, E>,
        PersistenceError | VersionConflictError,
        R | Scope.Scope | PersistenceAdapterTag
      > {
    if (isPersistentMachine(machine)) {
      // TypeScript can't narrow union with invariant generic params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return spawnPersistent(id, machine as PersistentMachine<S, E, R>);
    }
    return spawnRegular(
      id,
      machine as Machine<S, E, R, never, Record<string, never>, Record<string, never>, GD, EFD>,
    );
  }

  const restore = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    persistentMachine: PersistentMachine<S, E, R>,
  ): Effect.Effect<
    Option.Option<PersistentActorRef<S, E>>,
    PersistenceError,
    R | Scope.Scope | PersistenceAdapterTag
  > =>
    Effect.gen(function* () {
      // Try to restore from persistence
      const maybeActor = yield* restorePersistentActor(id, persistentMachine);

      if (Option.isSome(maybeActor)) {
        yield* registerActor(id, maybeActor.value);
      }

      return maybeActor;
    });

  const get = (id: string): Effect.Effect<Option.Option<ActorRef<AnyState, unknown>>> =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(actors);
      const actor = map.get(id);
      return actor !== undefined ? Option.some(actor) : Option.none();
    });

  const stop = (id: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(actors);
      const actor = map.get(id);
      if (actor === undefined) {
        return false;
      }

      yield* actor.stop;
      yield* SynchronizedRef.update(actors, (m) => {
        const newMap = new Map(m);
        newMap.delete(id);
        return newMap;
      });
      return true;
    });

  const listPersisted = (): Effect.Effect<
    ReadonlyArray<ActorMetadata>,
    PersistenceError,
    PersistenceAdapterTag
  > =>
    Effect.gen(function* () {
      const adapter = yield* PersistenceAdapterTag;
      if (adapter.listActors === undefined) {
        return [];
      }
      return yield* adapter.listActors();
    });

  const restoreMany = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    ids: ReadonlyArray<string>,
    persistentMachine: PersistentMachine<S, E, R>,
  ): Effect.Effect<RestoreResult<S, E>, never, R | Scope.Scope | PersistenceAdapterTag> =>
    Effect.gen(function* () {
      const restored: PersistentActorRef<S, E>[] = [];
      const failed: { id: string; error: PersistenceError }[] = [];

      for (const id of ids) {
        // Skip if already running
        const existing = yield* SynchronizedRef.get(actors);
        if (existing.has(id)) {
          continue;
        }

        const result = yield* Effect.either(restore(id, persistentMachine));
        if (result._tag === "Left") {
          failed.push({ id, error: result.left });
        } else if (Option.isSome(result.right)) {
          restored.push(result.right.value);
        } else {
          // No persisted state for this ID
          failed.push({
            id,
            error: new PersistenceErrorClass({
              operation: "restore",
              actorId: id,
              message: "No persisted state found",
            }),
          });
        }
      }

      return { restored, failed };
    });

  const restoreAll = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    persistentMachine: PersistentMachine<S, E, R>,
    options?: { filter?: (meta: ActorMetadata) => boolean },
  ): Effect.Effect<
    RestoreResult<S, E>,
    PersistenceError,
    R | Scope.Scope | PersistenceAdapterTag
  > =>
    Effect.gen(function* () {
      const adapter = yield* PersistenceAdapterTag;
      if (adapter.listActors === undefined) {
        return { restored: [], failed: [] };
      }

      // Require explicit machineType to prevent cross-machine restores
      const machineType = persistentMachine.persistence.machineType;
      if (machineType === undefined) {
        return yield* new PersistenceErrorClass({
          operation: "restoreAll",
          actorId: "*",
          message: "restoreAll requires explicit machineType in persistence config",
        });
      }

      const allMetadata = yield* adapter.listActors();

      // Filter by machineType and optional user filter
      let filtered = allMetadata.filter((meta) => meta.machineType === machineType);
      if (options?.filter !== undefined) {
        filtered = filtered.filter(options.filter);
      }

      const ids = filtered.map((meta) => meta.id);
      return yield* restoreMany(ids, persistentMachine);
    });

  return ActorSystem.of({ spawn, restore, get, stop, listPersisted, restoreMany, restoreAll });
});

/**
 * Default ActorSystem layer
 */
export const Default = Layer.effect(ActorSystem, make);
