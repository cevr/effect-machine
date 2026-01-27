/**
 * Machine namespace - Effect-style namespace export for all machine combinators.
 *
 * @example
 * ```ts
 * import { Machine } from "effect-machine"
 *
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.from(State.Typing).pipe(
 *     Machine.on(Event.KeyPress, h1),
 *     Machine.on(Event.Submit, h2),
 *   ),
 *   Machine.on(
 *     Machine.any(State.Running, State.Paused),
 *     Event.Cancel,
 *     () => State.Cancelled({})
 *   ),
 * )
 * ```
 *
 * @module
 */

// Core machine
export { make, build } from "./machine.js";
export type { EffectSlot, Machine, MachineBuilder, MachineRef, OnOptions } from "./machine.js";

// Combinators
export { on } from "./combinators/on.js";
export type { OnForceOptions } from "./combinators/on.js";
export { final } from "./combinators/final.js";
export { always } from "./combinators/always.js";
export type { AlwaysBranch, AlwaysEntry, AlwaysOtherwise } from "./combinators/always.js";
export { choose } from "./combinators/choose.js";
export type { ChooseBranch, ChooseEntry, ChooseOtherwise } from "./combinators/choose.js";
export { delay } from "./combinators/delay.js";
export type { DelayOptions, DurationOrFn } from "./combinators/delay.js";
export { onEnter } from "./combinators/on-enter.js";
export { onExit } from "./combinators/on-exit.js";
export { assign, update } from "./combinators/assign.js";
export { invoke } from "./combinators/invoke.js";
export { provide } from "./combinators/provide.js";
export type { EffectHandler, EffectHandlers } from "./combinators/provide.js";

// New combinators
export { from } from "./combinators/from.js";
export type { StateScope, ScopedTransition } from "./combinators/from.js";
export { any } from "./combinators/any.js";
export type { StateMatcher } from "./combinators/any.js";
