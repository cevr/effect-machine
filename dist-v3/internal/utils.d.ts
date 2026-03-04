import { ActorSystem } from "../actor.js";
import { Effect } from "effect";

//#region src-v3/internal/utils.d.ts
/**
 * Extracts _tag from a tagged union member
 */
type TagOf<T> = T extends {
  readonly _tag: infer Tag;
}
  ? Tag
  : never;
/**
 * Extracts args type from a Data.taggedEnum constructor
 */
type ArgsOf<C> = C extends (args: infer A) => unknown ? A : never;
/**
 * Extracts return type from a Data.taggedEnum constructor
 * @internal
 */
type InstanceOf<C> = C extends (...args: unknown[]) => infer R ? R : never;
/**
 * A tagged union constructor (from Data.taggedEnum)
 */
type TaggedConstructor<
  T extends {
    readonly _tag: string;
  },
> = (args: Omit<T, "_tag">) => T;
/**
 * Transition handler result - either a new state or Effect producing one
 */
type TransitionResult<State, R> = State | Effect.Effect<State, never, R>;
/**
 * Internal event tags used for lifecycle effect contexts.
 * Prefixed with $ to distinguish from user events.
 * @internal
 */
declare const INTERNAL_INIT_EVENT: "$init";
declare const INTERNAL_ENTER_EVENT: "$enter";
/**
 * Extract _tag from a tagged value or constructor.
 *
 * Supports:
 * - Plain values with `_tag` (MachineSchema empty structs)
 * - Constructors with static `_tag` (MachineSchema non-empty structs)
 * - Data.taggedEnum constructors (fallback via instantiation)
 */
declare const getTag: (
  constructorOrValue:
    | {
        _tag: string;
      }
    | ((...args: never[]) => {
        _tag: string;
      }),
) => string;
/** Check if a value is an Effect */
declare const isEffect: (value: unknown) => value is Effect.Effect<unknown, unknown, unknown>;
/**
 * Stub ActorSystem that dies on any method call.
 * Used in contexts where spawning/system access isn't supported
 * (testing simulation, persistent actor replay).
 * @internal
 */
declare const stubSystem: ActorSystem;
//#endregion
export {
  ArgsOf,
  INTERNAL_ENTER_EVENT,
  INTERNAL_INIT_EVENT,
  InstanceOf,
  TagOf,
  TaggedConstructor,
  TransitionResult,
  getTag,
  isEffect,
  stubSystem,
};
