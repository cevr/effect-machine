import { DuplicateActorError } from "../errors.js";
import { PersistentActorRef } from "./persistent-actor.js";
import { Effect, Option, Schema } from "effect";

//#region src-v3/persistence/adapter.d.ts
/**
 * Metadata for a persisted actor.
 * Used for discovery and filtering during bulk restore.
 */
interface ActorMetadata {
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
interface RestoreResult<
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R = never,
> {
  readonly restored: ReadonlyArray<PersistentActorRef<S, E, R>>;
  readonly failed: ReadonlyArray<RestoreFailure>;
}
/**
 * A single restore failure with actor ID and error details.
 */
interface RestoreFailure {
  readonly id: string;
  readonly error: PersistenceError | DuplicateActorError;
}
/**
 * Snapshot of actor state at a point in time
 */
interface Snapshot<S> {
  readonly state: S;
  readonly version: number;
  readonly timestamp: number;
}
/**
 * Persisted event with metadata
 */
interface PersistedEvent<E> {
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
interface PersistenceAdapter {
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
declare const PersistenceError_base: any;
/**
 * Error type for persistence operations
 */
declare class PersistenceError extends PersistenceError_base {}
declare const VersionConflictError_base: any;
/**
 * Version conflict error — snapshot version doesn't match expected
 */
declare class VersionConflictError extends VersionConflictError_base {}
declare const PersistenceAdapterTag_base: any;
/**
 * PersistenceAdapter service tag
 */
declare class PersistenceAdapterTag extends PersistenceAdapterTag_base {}
//#endregion
export {
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  PersistenceAdapterTag,
  PersistenceError,
  RestoreFailure,
  RestoreResult,
  Snapshot,
  VersionConflictError,
};
