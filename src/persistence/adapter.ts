import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

/**
 * Snapshot of actor state at a point in time
 */
export interface Snapshot<S> {
  readonly state: S;
  readonly version: number;
  readonly timestamp: number;
}

/**
 * Persisted event with metadata
 */
export interface PersistedEvent<E> {
  readonly event: E;
  readonly version: number;
  readonly timestamp: number;
}

/**
 * Adapter for persisting actor state and events.
 *
 * Implementations handle serialization and storage of snapshots and event journals.
 * Schema parameters ensure type-safe serialization/deserialization.
 * Schemas must have no context requirements (use Schema<S, SI, never>).
 */
export interface PersistenceAdapter {
  /**
   * Save a snapshot of actor state.
   * Implementations should use optimistic locking — fail if version mismatch.
   */
  readonly saveSnapshot: <S, SI>(
    id: string,
    snapshot: Snapshot<S>,
    schema: Schema.Schema<S, SI, never>,
  ) => Effect.Effect<void, PersistenceError | VersionConflictError>;

  /**
   * Load the latest snapshot for an actor.
   * Returns None if no snapshot exists.
   */
  readonly loadSnapshot: <S, SI>(
    id: string,
    schema: Schema.Schema<S, SI, never>,
  ) => Effect.Effect<Option.Option<Snapshot<S>>, PersistenceError>;

  /**
   * Append an event to the actor's event journal.
   */
  readonly appendEvent: <E, EI>(
    id: string,
    event: PersistedEvent<E>,
    schema: Schema.Schema<E, EI, never>,
  ) => Effect.Effect<void, PersistenceError>;

  /**
   * Load events from the journal, optionally after a specific version.
   */
  readonly loadEvents: <E, EI>(
    id: string,
    schema: Schema.Schema<E, EI, never>,
    afterVersion?: number,
  ) => Effect.Effect<ReadonlyArray<PersistedEvent<E>>, PersistenceError>;

  /**
   * Delete all persisted data for an actor (snapshot + events).
   */
  readonly deleteActor: (id: string) => Effect.Effect<void, PersistenceError>;
}

/**
 * Error type for persistence operations
 */
export class PersistenceError extends Schema.TaggedError<PersistenceError>()("PersistenceError", {
  operation: Schema.String,
  actorId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
}) {}

/**
 * Version conflict error — snapshot version doesn't match expected
 */
export class VersionConflictError extends Schema.TaggedError<VersionConflictError>()(
  "VersionConflictError",
  {
    actorId: Schema.String,
    expectedVersion: Schema.Number,
    actualVersion: Schema.Number,
  },
) {}

/**
 * PersistenceAdapter service tag
 */
export class PersistenceAdapterTag extends Context.Tag(
  "effect-machine/persistence/adapter/PersistenceAdapterTag",
)<PersistenceAdapterTag, PersistenceAdapter>() {}
