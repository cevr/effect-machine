import { Context, Schema } from "effect";
import type { Effect, Option } from "effect";

import type { PersistentActorRef } from "./persistent-actor.js";
import type { DuplicateActorError, UnprovidedSlotsError } from "../errors.js";

/**
 * Metadata for a persisted actor.
 * Used for discovery and filtering during bulk restore.
 */
export interface ActorMetadata {
  readonly id: string;
  /** User-provided identifier for the machine type */
  readonly machineType: string;
  readonly createdAt: number;
  readonly lastActivityAt: number;
  readonly version: number;
  /** Current state _tag value */
  readonly stateTag: string;
}

/**
 * Result of a bulk restore operation.
 * Contains both successfully restored actors and failures.
 */
export interface RestoreResult<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R = never,
> {
  readonly restored: ReadonlyArray<PersistentActorRef<S, E, R>>;
  readonly failed: ReadonlyArray<RestoreFailure>;
}

/**
 * A single restore failure with actor ID and error details.
 */
export interface RestoreFailure {
  readonly id: string;
  readonly error: PersistenceError | DuplicateActorError | UnprovidedSlotsError;
}

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

  // --- Optional registry methods for actor discovery ---

  /**
   * List all persisted actor metadata.
   * Optional — adapters without registry support can omit this.
   */
  readonly listActors?: () => Effect.Effect<ReadonlyArray<ActorMetadata>, PersistenceError>;

  /**
   * Save or update actor metadata.
   * Called on spawn and state transitions.
   * Optional — adapters without registry support can omit this.
   */
  readonly saveMetadata?: (metadata: ActorMetadata) => Effect.Effect<void, PersistenceError>;

  /**
   * Delete actor metadata.
   * Called when actor is deleted.
   * Optional — adapters without registry support can omit this.
   */
  readonly deleteMetadata?: (id: string) => Effect.Effect<void, PersistenceError>;

  /**
   * Load metadata for a specific actor by ID.
   * Returns None if no metadata exists.
   * Optional — adapters without registry support can omit this.
   */
  readonly loadMetadata?: (
    id: string,
  ) => Effect.Effect<Option.Option<ActorMetadata>, PersistenceError>;
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
  "effect-machine/src/persistence/adapter/PersistenceAdapterTag",
)<PersistenceAdapterTag, PersistenceAdapter>() {}
