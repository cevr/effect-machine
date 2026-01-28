/**
 * Machine namespace - fluent builder API for state machines.
 *
 * @example
 * ```ts
 * import { Machine, State, Event, Slot } from "effect-machine"
 *
 * const MyState = State({ Idle: {}, Running: { count: Schema.Number } })
 * const MyEvent = Event({ Start: {}, Stop: {} })
 *
 * const MyGuards = Slot.Guards({
 *   canStart: { threshold: Schema.Number },
 * })
 *
 * const MyEffects = Slot.Effects({
 *   notify: { message: Schema.String },
 * })
 *
 * const machine = Machine.make({
 *   state: MyState,
 *   event: MyEvent,
 *   guards: MyGuards,
 *   effects: MyEffects,
 *   initial: MyState.Idle,
 * })
 *   .on(MyState.Idle, MyEvent.Start, ({ state, guards, effects }) =>
 *     Effect.gen(function* () {
 *       if (yield* guards.canStart({ threshold: 5 })) {
 *         yield* effects.notify({ message: "Starting!" })
 *         return MyState.Running({ count: 0 })
 *       }
 *       return state
 *     })
 *   )
 *   .on(MyState.Running, MyEvent.Stop, () => MyState.Idle)
 *   .final(MyState.Idle)
 *   .provide({
 *     canStart: ({ threshold }) => Effect.succeed(threshold > 0),
 *     notify: ({ message }) => Effect.log(message),
 *   })
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
  Transition,
  AlwaysTransition,
  StateEffect,
  PersistOptions,
  HandlerContext,
  StateHandlerContext,
  ProvideHandlers,
} from "./machine.js";

// Helpers - assign is used inside handlers
export { assign } from "./combinators/assign.js";

// Persistence types
export type { PersistenceConfig, PersistentMachine } from "./persistence/index.js";

// Transition lookup (introspection)
export { findTransitions, findAlwaysTransitions } from "./internal/transition-index.js";
