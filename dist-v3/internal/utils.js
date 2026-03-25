import { Effect, Stream } from "effect";
//#region src-v3/internal/utils.ts
/**
 * Internal event tags used for lifecycle effect contexts.
 * Prefixed with $ to distinguish from user events.
 * @internal
 */
const INTERNAL_INIT_EVENT = "$init";
const INTERNAL_ENTER_EVENT = "$enter";
/**
 * Extract _tag from a tagged value or constructor.
 *
 * Supports:
 * - Plain values with `_tag` (MachineSchema empty structs)
 * - Constructors with static `_tag` (MachineSchema non-empty structs)
 * - Data.taggedEnum constructors (fallback via instantiation)
 */
const getTag = (constructorOrValue) => {
  if ("_tag" in constructorOrValue && typeof constructorOrValue._tag === "string")
    return constructorOrValue._tag;
  try {
    return constructorOrValue()._tag;
  } catch {
    return constructorOrValue({})._tag;
  }
};
/** Check if a value is an Effect */
const isEffect = (value) =>
  typeof value === "object" && value !== null && Effect.EffectTypeId in value;
/**
 * Stub ActorSystem that dies on any method call.
 * Used in contexts where spawning/system access isn't supported
 * (testing simulation, persistent actor replay).
 * @internal
 */
const stubSystem = {
  spawn: () => Effect.die("spawn not supported in stub system"),
  restore: () => Effect.die("restore not supported in stub system"),
  get: () => Effect.die("get not supported in stub system"),
  stop: () => Effect.die("stop not supported in stub system"),
  events: Stream.empty,
  get actors() {
    return /* @__PURE__ */ new Map();
  },
  subscribe: () => () => {},
  listPersisted: () => Effect.die("listPersisted not supported in stub system"),
  restoreMany: () => Effect.die("restoreMany not supported in stub system"),
  restoreAll: () => Effect.die("restoreAll not supported in stub system"),
};
//#endregion
export { INTERNAL_ENTER_EVENT, INTERNAL_INIT_EVENT, getTag, isEffect, stubSystem };
