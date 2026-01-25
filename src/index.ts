// Core machine types and constructors
export type {
  AlwaysTransition,
  Machine,
  MachineBuilder,
  MachineRef,
  OnOptions,
  StateEffect,
  Transition,
} from "./machine.js";
export {
  addAlwaysTransition,
  addFinal,
  addOnEnter,
  addOnExit,
  addTransition,
  build,
  make,
} from "./machine.js";

// Actor types
export type { ActorRef } from "./actor-ref.js";

// Actor system
export type { ActorSystem } from "./actor-system.js";
export { ActorSystem as ActorSystemService, Default as ActorSystemDefault } from "./actor-system.js";

// Combinators
export { always } from "./combinators/always.js";
export type { AlwaysBranch, AlwaysEntry, AlwaysOtherwise } from "./combinators/always.js";
export { assign, update } from "./combinators/assign.js";
export { choose } from "./combinators/choose.js";
export type { ChooseBranch, ChooseEntry, ChooseOtherwise } from "./combinators/choose.js";
export { delay } from "./combinators/delay.js";
export type { DelayOptions } from "./combinators/delay.js";
export { final } from "./combinators/final.js";
export { invoke } from "./combinators/invoke.js";
export { on } from "./combinators/on.js";
export { onEnter } from "./combinators/on-enter.js";
export { onExit } from "./combinators/on-exit.js";

// Testing utilities
export {
  AssertionError,
  assertReaches,
  createTestHarness,
  simulate,
  yieldFibers,
} from "./testing.js";
export type { SimulationResult, TestHarness } from "./testing.js";

// Re-export internal types that users might need
export type {
  Guard,
  GuardFn,
  GuardInput,
  InstanceOf,
  StateEffectContext,
  StateEffectHandler,
  TransitionContext,
  TransitionHandler,
  TransitionOptions,
  TransitionResult,
} from "./internal/types.js";
export { Guard as GuardModule, normalizeGuard } from "./internal/types.js";
