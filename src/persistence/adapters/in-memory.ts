import { Effect, Layer, Option, Ref, Schema } from "effect";

import type { PersistedEvent, PersistenceAdapter, Snapshot } from "../adapter.js";
import { PersistenceAdapterTag, PersistenceError, VersionConflictError } from "../adapter.js";

/**
 * In-memory storage for a single actor
 */
interface ActorStorage {
  snapshot: Option.Option<{
    readonly data: unknown;
    readonly version: number;
    readonly timestamp: number;
  }>;
  events: Array<{ readonly data: unknown; readonly version: number; readonly timestamp: number }>;
}

/**
 * Create an in-memory persistence adapter.
 * Useful for testing and development.
 */
const make = Effect.gen(function* () {
  const storage = yield* Ref.make(new Map<string, ActorStorage>());

  const getOrCreateStorage = (id: string): Effect.Effect<ActorStorage> =>
    Ref.modify(storage, (map) => {
      const existing = map.get(id);
      if (existing !== undefined) {
        return [existing, map];
      }
      const newStorage: ActorStorage = {
        snapshot: Option.none(),
        events: [],
      };
      const newMap = new Map(map);
      newMap.set(id, newStorage);
      return [newStorage, newMap];
    });

  const updateStorage = (
    id: string,
    update: (storage: ActorStorage) => ActorStorage,
  ): Effect.Effect<void> =>
    Ref.update(storage, (map) => {
      const existing = map.get(id);
      if (existing === undefined) {
        return map;
      }
      const newMap = new Map(map);
      newMap.set(id, update(existing));
      return newMap;
    });

  const adapter: PersistenceAdapter = {
    saveSnapshot: <S, SI>(
      id: string,
      snapshot: Snapshot<S>,
      schema: Schema.Schema<S, SI, never>,
    ): Effect.Effect<void, PersistenceError | VersionConflictError> =>
      Effect.gen(function* () {
        const actorStorage = yield* getOrCreateStorage(id);

        // Optimistic locking: check version
        // Reject only if trying to save an older version (strict <)
        // Same-version saves are idempotent (allow retries/multiple callers)
        if (Option.isSome(actorStorage.snapshot)) {
          const existingVersion = actorStorage.snapshot.value.version;
          if (snapshot.version < existingVersion) {
            return yield* new VersionConflictError({
              actorId: id,
              expectedVersion: existingVersion,
              actualVersion: snapshot.version,
            });
          }
        }

        // Encode state using schema
        const encoded = yield* Schema.encode(schema)(snapshot.state).pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: "saveSnapshot",
                actorId: id,
                cause,
                message: "Failed to encode state",
              }),
          ),
        );

        yield* updateStorage(id, (s) => ({
          ...s,
          snapshot: Option.some({
            data: encoded,
            version: snapshot.version,
            timestamp: snapshot.timestamp,
          }),
        }));
      }),

    loadSnapshot: <S, SI>(
      id: string,
      schema: Schema.Schema<S, SI, never>,
    ): Effect.Effect<Option.Option<Snapshot<S>>, PersistenceError> =>
      Effect.gen(function* () {
        const actorStorage = yield* getOrCreateStorage(id);

        if (Option.isNone(actorStorage.snapshot)) {
          return Option.none();
        }

        const stored = actorStorage.snapshot.value;

        // Decode state using schema
        const decoded = yield* Schema.decode(schema)(stored.data as SI).pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: "loadSnapshot",
                actorId: id,
                cause,
                message: "Failed to decode state",
              }),
          ),
        );

        return Option.some({
          state: decoded,
          version: stored.version,
          timestamp: stored.timestamp,
        });
      }),

    appendEvent: <E, EI>(
      id: string,
      event: PersistedEvent<E>,
      schema: Schema.Schema<E, EI, never>,
    ): Effect.Effect<void, PersistenceError> =>
      Effect.gen(function* () {
        yield* getOrCreateStorage(id);

        // Encode event using schema
        const encoded = yield* Schema.encode(schema)(event.event).pipe(
          Effect.mapError(
            (cause) =>
              new PersistenceError({
                operation: "appendEvent",
                actorId: id,
                cause,
                message: "Failed to encode event",
              }),
          ),
        );

        yield* updateStorage(id, (s) => ({
          ...s,
          events: [
            ...s.events,
            {
              data: encoded,
              version: event.version,
              timestamp: event.timestamp,
            },
          ],
        }));
      }),

    loadEvents: <E, EI>(
      id: string,
      schema: Schema.Schema<E, EI, never>,
      afterVersion?: number,
    ): Effect.Effect<ReadonlyArray<PersistedEvent<E>>, PersistenceError> =>
      Effect.gen(function* () {
        const actorStorage = yield* getOrCreateStorage(id);

        const filteredEvents =
          afterVersion !== undefined
            ? actorStorage.events.filter((e) => e.version > afterVersion)
            : actorStorage.events;

        const decoded: PersistedEvent<E>[] = [];
        for (const stored of filteredEvents) {
          const event = yield* Schema.decode(schema)(stored.data as EI).pipe(
            Effect.mapError(
              (cause) =>
                new PersistenceError({
                  operation: "loadEvents",
                  actorId: id,
                  cause,
                  message: "Failed to decode event",
                }),
            ),
          );
          decoded.push({
            event,
            version: stored.version,
            timestamp: stored.timestamp,
          });
        }

        return decoded;
      }),

    deleteActor: (id: string): Effect.Effect<void, PersistenceError> =>
      Ref.update(storage, (map) => {
        const newMap = new Map(map);
        newMap.delete(id);
        return newMap;
      }),
  };

  return adapter;
});

/**
 * Create an in-memory persistence adapter effect.
 * Returns the adapter directly for custom layer composition.
 */
export const makeInMemoryPersistenceAdapter = make;

/**
 * In-memory persistence adapter layer.
 * Data is not persisted across process restarts.
 *
 * NOTE: Each `Effect.provide(InMemoryPersistenceAdapter)` creates a NEW adapter
 * with empty storage. For tests that need persistent storage across multiple
 * runPromise calls, use `makeInMemoryPersistenceAdapter` with a shared scope.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const system = yield* ActorSystemService;
 *   const actor = yield* system.spawn("my-actor", persistentMachine);
 *   // ...
 * }).pipe(
 *   Effect.provide(InMemoryPersistenceAdapter),
 *   Effect.provide(ActorSystemDefault),
 * );
 * ```
 */
export const InMemoryPersistenceAdapter: Layer.Layer<PersistenceAdapterTag> = Layer.effect(
  PersistenceAdapterTag,
  make,
);
