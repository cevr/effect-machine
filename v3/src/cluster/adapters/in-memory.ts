/**
 * In-memory persistence adapter for testing and development (v3).
 *
 * @module
 */
import { Effect, Layer, Option, Ref } from "effect";

import { VersionConflictError } from "../../errors.js";
import {
  PersistenceAdapter,
  type PersistenceKey,
  type PersistedEvent,
  type Snapshot,
} from "../persistence.js";

// ============================================================================
// Internal storage shape
// ============================================================================

interface EntityStore {
  snapshot: Snapshot<unknown> | undefined;
  events: Array<PersistedEvent<unknown>>;
}

const makeKey = (key: PersistenceKey): string => `${key.entityType}/${key.entityId}`;

const getOrCreate = (store: Map<string, EntityStore>, key: string): EntityStore => {
  let entry = store.get(key);
  if (entry === undefined) {
    entry = { snapshot: undefined, events: [] };
    store.set(key, entry);
  }
  return entry;
};

// ============================================================================
// Adapter implementation
// ============================================================================

export const makeInMemoryPersistenceAdapter = Effect.gen(function* () {
  const store = new Map<string, EntityStore>();
  const storeRef = yield* Ref.make(store);

  const adapter: PersistenceAdapter = {
    saveSnapshot: (key, snapshot) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(storeRef);
        const k = makeKey(key);
        const entry = getOrCreate(s, k);

        if (entry.snapshot !== undefined && snapshot.version < entry.snapshot.version) {
          return yield* new VersionConflictError({
            expected: snapshot.version,
            actual: entry.snapshot.version,
          });
        }

        entry.snapshot = snapshot;
      }),

    loadSnapshot: (key) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(storeRef);
        const entry = s.get(makeKey(key));
        return Option.fromNullable(entry?.snapshot);
      }),

    appendEvents: (key, events, expectedVersion) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(storeRef);
        const k = makeKey(key);
        const entry = getOrCreate(s, k);
        const lastEvent = entry.events[entry.events.length - 1];
        const currentVersion = lastEvent !== undefined ? lastEvent.version : 0;

        if (currentVersion !== expectedVersion) {
          return yield* new VersionConflictError({
            expected: expectedVersion,
            actual: currentVersion,
          });
        }

        for (const event of events) {
          entry.events.push(event);
        }
      }),

    loadEvents: (key, afterVersion) =>
      Effect.gen(function* () {
        const s = yield* Ref.get(storeRef);
        const entry = s.get(makeKey(key));
        if (entry === undefined) return [];
        if (afterVersion === undefined) return entry.events;
        return entry.events.filter((e) => e.version > afterVersion);
      }),
  };

  return {
    adapter,
    storeRef,
    layer: Layer.succeed(PersistenceAdapter, adapter),
  };
});
