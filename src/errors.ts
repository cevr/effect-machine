/**
 * Typed error classes for effect-machine.
 *
 * All errors extend Schema.TaggedErrorClassClass for:
 * - Type-safe catching via Effect.catchTag
 * - Serialization support
 * - Composable error handling
 *
 * @module
 */
import { Schema } from "effect";

/** Attempted to spawn/restore actor with ID already in use */
export class DuplicateActorError extends Schema.TaggedErrorClass<DuplicateActorError>()(
  "DuplicateActorError",
  { actorId: Schema.String },
) {}

/** Machine has unprovided effect slots */
export class UnprovidedSlotsError extends Schema.TaggedErrorClass<UnprovidedSlotsError>()(
  "UnprovidedSlotsError",
  { slots: Schema.Array(Schema.String) },
) {}

/** Operation requires schemas attached to machine */
export class MissingSchemaError extends Schema.TaggedErrorClass<MissingSchemaError>()(
  "MissingSchemaError",
  { operation: Schema.String },
) {}

/** State/Event schema has no variants */
export class InvalidSchemaError extends Schema.TaggedErrorClass<InvalidSchemaError>()(
  "InvalidSchemaError",
  {},
) {}

/** $match called with missing handler for tag */
export class MissingMatchHandlerError extends Schema.TaggedErrorClass<MissingMatchHandlerError>()(
  "MissingMatchHandlerError",
  { tag: Schema.String },
) {}

/** Slot handler not found at runtime (internal error) */
export class SlotProvisionError extends Schema.TaggedErrorClass<SlotProvisionError>()(
  "SlotProvisionError",
  {
    slotName: Schema.String,
    slotType: Schema.Literals(["guard", "effect"]),
  },
) {}

/** Machine.build() validation failed - missing or extra handlers */
export class ProvisionValidationError extends Schema.TaggedErrorClass<ProvisionValidationError>()(
  "ProvisionValidationError",
  {
    missing: Schema.Array(Schema.String),
    extra: Schema.Array(Schema.String),
  },
) {}

/** Assertion failed in testing utilities */
export class AssertionError extends Schema.TaggedErrorClass<AssertionError>()("AssertionError", {
  message: Schema.String,
}) {}

/** Actor was stopped while a call/ask was pending */
export class ActorStoppedError extends Schema.TaggedErrorClass<ActorStoppedError>()(
  "ActorStoppedError",
  { actorId: Schema.String },
) {}

/** ask() was used but the transition handler did not call reply */
export class NoReplyError extends Schema.TaggedErrorClass<NoReplyError>()("NoReplyError", {
  actorId: Schema.String,
  eventTag: Schema.String,
}) {}

/** Persistence adapter operation failed */
export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "PersistenceError",
  { message: Schema.String },
) {}

/** Optimistic locking failure — stored version doesn't match expected */
export class VersionConflictError extends Schema.TaggedErrorClass<VersionConflictError>()(
  "VersionConflictError",
  { expected: Schema.Number, actual: Schema.Number },
) {}
