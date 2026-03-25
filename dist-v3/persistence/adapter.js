import { Context, Schema } from "effect";
//#region src-v3/persistence/adapter.ts
/**
 * Error type for persistence operations
 */
var PersistenceError = class extends Schema.TaggedError()("PersistenceError", {
  operation: Schema.String,
  actorId: Schema.String,
  cause: Schema.optional(Schema.Unknown),
  message: Schema.optional(Schema.String),
}) {};
/**
 * Version conflict error — snapshot version doesn't match expected
 */
var VersionConflictError = class extends Schema.TaggedError()("VersionConflictError", {
  actorId: Schema.String,
  expectedVersion: Schema.Number,
  actualVersion: Schema.Number,
}) {};
/**
 * PersistenceAdapter service tag
 */
var PersistenceAdapterTag = class extends Context.Tag(
  "effect-machine/src/persistence/adapter/PersistenceAdapterTag",
)() {};
//#endregion
export { PersistenceAdapterTag, PersistenceError, VersionConflictError };
