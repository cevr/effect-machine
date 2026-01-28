/**
 * Typed error classes for effect-machine.
 *
 * All errors extend Schema.TaggedError for:
 * - Type-safe catching via Effect.catchTag
 * - Serialization support
 * - Composable error handling
 *
 * @module
 */
import { Schema } from "effect";

/** Attempted to spawn/restore actor with ID already in use */
export class DuplicateActorError extends Schema.TaggedError<DuplicateActorError>()(
  "DuplicateActorError",
  { actorId: Schema.String },
) {}

/** Machine has unprovided effect slots */
export class UnprovidedSlotsError extends Schema.TaggedError<UnprovidedSlotsError>()(
  "UnprovidedSlotsError",
  { slots: Schema.Array(Schema.String) },
) {}

/** Operation requires schemas attached to machine */
export class MissingSchemaError extends Schema.TaggedError<MissingSchemaError>()(
  "MissingSchemaError",
  { operation: Schema.String },
) {}

/** State/Event schema has no variants */
export class InvalidSchemaError extends Schema.TaggedError<InvalidSchemaError>()(
  "InvalidSchemaError",
  {},
) {}

/** $match called with missing handler for tag */
export class MissingMatchHandlerError extends Schema.TaggedError<MissingMatchHandlerError>()(
  "MissingMatchHandlerError",
  { tag: Schema.String },
) {}

/** Slot handler not found at runtime (internal error) */
export class SlotProvisionError extends Schema.TaggedError<SlotProvisionError>()(
  "SlotProvisionError",
  {
    slotName: Schema.String,
    slotType: Schema.Literal("guard", "effect"),
  },
) {}

/** Machine.provide() validation failed - missing or extra handlers */
export class ProvisionValidationError extends Schema.TaggedError<ProvisionValidationError>()(
  "ProvisionValidationError",
  {
    missing: Schema.Array(Schema.String),
    extra: Schema.Array(Schema.String),
  },
) {}

/** Assertion failed in testing utilities */
export class AssertionError extends Schema.TaggedError<AssertionError>()("AssertionError", {
  message: Schema.String,
}) {}
