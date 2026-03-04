import { PersistenceAdapterTag, PersistenceError, VersionConflictError } from "../adapter.js";
import { Effect, Layer, Option, Ref, Schema } from "effect";

//#region src-v3/persistence/adapters/in-memory.ts
/**
 * Create an in-memory persistence adapter.
 * Useful for testing and development.
 */
const make = Effect.gen(function* () {
  const storage = yield* Ref.make(/* @__PURE__ */ new Map());
  const registry = yield* Ref.make(/* @__PURE__ */ new Map());
  const getOrCreateStorage = Effect.fn("effect-machine.persistence.inMemory.getOrCreateStorage")(
    function* (id) {
      return yield* Ref.modify(storage, (map) => {
        const existing = map.get(id);
        if (existing !== void 0) return [existing, map];
        const newStorage = {
          snapshot: Option.none(),
          events: [],
        };
        const newMap = new Map(map);
        newMap.set(id, newStorage);
        return [newStorage, newMap];
      });
    },
  );
  const updateStorage = Effect.fn("effect-machine.persistence.inMemory.updateStorage")(
    function* (id, update) {
      yield* Ref.update(storage, (map) => {
        const existing = map.get(id);
        if (existing === void 0) return map;
        const newMap = new Map(map);
        newMap.set(id, update(existing));
        return newMap;
      });
    },
  );
  return {
    saveSnapshot: Effect.fn("effect-machine.persistence.inMemory.saveSnapshot")(
      function* (id, snapshot, schema) {
        const actorStorage = yield* getOrCreateStorage(id);
        if (Option.isSome(actorStorage.snapshot)) {
          const existingVersion = actorStorage.snapshot.value.version;
          if (snapshot.version < existingVersion)
            return yield* new VersionConflictError({
              actorId: id,
              expectedVersion: existingVersion,
              actualVersion: snapshot.version,
            });
        }
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
      },
    ),
    loadSnapshot: Effect.fn("effect-machine.persistence.inMemory.loadSnapshot")(
      function* (id, schema) {
        const actorStorage = yield* getOrCreateStorage(id);
        if (Option.isNone(actorStorage.snapshot)) return Option.none();
        const stored = actorStorage.snapshot.value;
        const decoded = yield* Schema.decode(schema)(stored.data).pipe(
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
      },
    ),
    appendEvent: Effect.fn("effect-machine.persistence.inMemory.appendEvent")(
      function* (id, event, schema) {
        yield* getOrCreateStorage(id);
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
      },
    ),
    loadEvents: Effect.fn("effect-machine.persistence.inMemory.loadEvents")(
      function* (id, schema, afterVersion) {
        const actorStorage = yield* getOrCreateStorage(id);
        const decoded = [];
        for (const stored of actorStorage.events) {
          if (afterVersion !== void 0 && stored.version <= afterVersion) continue;
          const event = yield* Schema.decode(schema)(stored.data).pipe(
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
      },
    ),
    deleteActor: Effect.fn("effect-machine.persistence.inMemory.deleteActor")(function* (id) {
      yield* Ref.update(storage, (map) => {
        const newMap = new Map(map);
        newMap.delete(id);
        return newMap;
      });
      yield* Ref.update(registry, (map) => {
        const newMap = new Map(map);
        newMap.delete(id);
        return newMap;
      });
    }),
    listActors: Effect.fn("effect-machine.persistence.inMemory.listActors")(function* () {
      const map = yield* Ref.get(registry);
      return Array.from(map.values());
    }),
    saveMetadata: Effect.fn("effect-machine.persistence.inMemory.saveMetadata")(
      function* (metadata) {
        yield* Ref.update(registry, (map) => {
          const newMap = new Map(map);
          newMap.set(metadata.id, metadata);
          return newMap;
        });
      },
    ),
    deleteMetadata: Effect.fn("effect-machine.persistence.inMemory.deleteMetadata")(function* (id) {
      yield* Ref.update(registry, (map) => {
        const newMap = new Map(map);
        newMap.delete(id);
        return newMap;
      });
    }),
    loadMetadata: Effect.fn("effect-machine.persistence.inMemory.loadMetadata")(function* (id) {
      const meta = (yield* Ref.get(registry)).get(id);
      return meta !== void 0 ? Option.some(meta) : Option.none();
    }),
  };
}).pipe(Effect.withSpan("effect-machine.persistence.inMemory.make"));
/**
 * Create an in-memory persistence adapter effect.
 * Returns the adapter directly for custom layer composition.
 */
const makeInMemoryPersistenceAdapter = make;
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
const InMemoryPersistenceAdapter = Layer.effect(PersistenceAdapterTag, make);

//#endregion
export { InMemoryPersistenceAdapter, makeInMemoryPersistenceAdapter };
