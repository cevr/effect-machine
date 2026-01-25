// Core machine types and constructors
export type {
  AlwaysTransition,
  Machine,
  MachineBuilder,
  MachineRef,
  OnOptions,
  StateEffect,
  Transition,
} from "./Machine.js";
export {
  addAlwaysTransition,
  addFinal,
  addOnEnter,
  addOnExit,
  addTransition,
  build,
  make,
} from "./Machine.js";

// Actor types
export type { ActorRef } from "./ActorRef.js";

// Actor system
export type { ActorSystem } from "./ActorSystem.js";
export { ActorSystem as ActorSystemService, Default as ActorSystemDefault } from "./ActorSystem.js";

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
export { onEnter } from "./combinators/onEnter.js";
export { onExit } from "./combinators/onExit.js";

// Testing utilities
export {
  AssertionError,
  assertReaches,
  createTestHarness,
  simulate,
  yieldFibers,
} from "./Testing.js";
export type { SimulationResult, TestHarness } from "./Testing.js";

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
