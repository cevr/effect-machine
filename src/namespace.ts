/**
 * Machine namespace - fluent builder API for state machines.
 *
 * @example
 * ```ts
 * import { Machine, State, Event } from "effect-machine"
 *
 * const MyState = State({ Idle: {}, Running: { count: Schema.Number } })
 * const MyEvent = Event({ Start: {}, Stop: {} })
 *
 * const machine = Machine.make({ state: MyState, event: MyEvent, initial: MyState.Idle })
 *   .on(MyState.Idle, MyEvent.Start, () => MyState.Running({ count: 0 }))
 *   .on(MyState.Running, MyEvent.Stop, () => MyState.Idle)
 *   .final(MyState.Idle)
 * ```
 *
 * @module
 */

// Core - just re-export make and types
export { make } from "./machine.js";
export type {
  Machine,
  MachineRef,
  MakeConfig,
  AnySlot,
  EffectSlot,
  EffectSlotType,
  Transition,
  AlwaysTransition,
  StateEffect,
  RootInvoke,
  GuardHandler,
  OnOptions,
  OnForceOptions,
  DelayOptions,
  DurationOrFn,
  PersistOptions,
  AlwaysBranch,
  ChooseBranch,
  ChooseEntry,
  ChooseOtherwise,
  EffectHandler,
  EffectHandlers,
  FromScope,
} from "./machine.js";

// Helpers - assign is used inside handlers
export { assign } from "./combinators/assign.js";

// Guard - for creating guard slots
export { Guard } from "./internal/types.js";
export type { Guard as GuardType } from "./internal/types.js";

// Persistence types
export type { PersistenceConfig, PersistentMachine } from "./persistence/index.js";

// Transition lookup (introspection)
export { findTransitions, findAlwaysTransitions } from "./internal/transition-index.js";
