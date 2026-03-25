import { Schema } from "effect";
//#region src-v3/errors.ts
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
/** Attempted to spawn/restore actor with ID already in use */
var DuplicateActorError = class extends Schema.TaggedError()("DuplicateActorError", {
  actorId: Schema.String,
}) {};
/** Machine has unprovided effect slots */
var UnprovidedSlotsError = class extends Schema.TaggedError()("UnprovidedSlotsError", {
  slots: Schema.Array(Schema.String),
}) {};
/** Operation requires schemas attached to machine */
var MissingSchemaError = class extends Schema.TaggedError()("MissingSchemaError", {
  operation: Schema.String,
}) {};
/** State/Event schema has no variants */
var InvalidSchemaError = class extends Schema.TaggedError()("InvalidSchemaError", {}) {};
/** $match called with missing handler for tag */
var MissingMatchHandlerError = class extends Schema.TaggedError()("MissingMatchHandlerError", {
  tag: Schema.String,
}) {};
/** Slot handler not found at runtime (internal error) */
var SlotProvisionError = class extends Schema.TaggedError()("SlotProvisionError", {
  slotName: Schema.String,
  slotType: Schema.Literal("guard", "effect"),
}) {};
/** Machine.build() validation failed - missing or extra handlers */
var ProvisionValidationError = class extends Schema.TaggedError()("ProvisionValidationError", {
  missing: Schema.Array(Schema.String),
  extra: Schema.Array(Schema.String),
}) {};
/** Assertion failed in testing utilities */
var AssertionError = class extends Schema.TaggedError()("AssertionError", {
  message: Schema.String,
}) {};
//#endregion
export {
  AssertionError,
  DuplicateActorError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  MissingSchemaError,
  ProvisionValidationError,
  SlotProvisionError,
  UnprovidedSlotsError,
};
