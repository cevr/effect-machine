// Machine namespace (Effect-style)
export * as Machine from "./namespace.js";

// Core machine types and constructors
export type {
  AlwaysTransition,
  Machine as MachineType,
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
export {
  ActorSystem as ActorSystemService,
  Default as ActorSystemDefault,
} from "./actor-system.js";

// Combinators
export { always } from "./combinators/always.js";
export type { AlwaysBranch, AlwaysEntry, AlwaysOtherwise } from "./combinators/always.js";
export { assign, update } from "./combinators/assign.js";
export { choose } from "./combinators/choose.js";
export type { ChooseBranch, ChooseEntry, ChooseOtherwise } from "./combinators/choose.js";
export { delay } from "./combinators/delay.js";
export type { DelayOptions, DurationOrFn } from "./combinators/delay.js";
export { final } from "./combinators/final.js";
export { invoke } from "./combinators/invoke.js";
export { on } from "./combinators/on.js";
export type { OnForceOptions } from "./combinators/on.js";
export { onEnter } from "./combinators/on-enter.js";
export { onExit } from "./combinators/on-exit.js";
export { from } from "./combinators/from.js";
export type { StateScope, ScopedTransition } from "./combinators/from.js";
export { any } from "./combinators/any.js";
export type { StateMatcher } from "./combinators/any.js";

// Testing utilities
export {
  AssertionError,
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
  yieldFibers,
} from "./testing.js";
export type { SimulationResult, TestHarness, TestHarnessOptions } from "./testing.js";

// Re-export internal types that users might need
export type {
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
export { Guard, normalizeGuard } from "./internal/types.js";
export type { Guard as GuardType } from "./internal/types.js";

// Inspection / introspection
export type {
  EffectEvent,
  EventReceivedEvent,
  GuardEvaluatedEvent,
  InspectionEvent,
  Inspector,
  SpawnEvent,
  StopEvent,
  TransitionEvent,
} from "./inspection.js";
export {
  collectingInspector,
  consoleInspector,
  Inspector as InspectorService,
  makeInspector,
} from "./inspection.js";

// Persistence
export type {
  PersistedEvent,
  PersistenceAdapter,
  PersistenceConfig,
  PersistentActorRef,
  PersistentMachine,
  Snapshot,
} from "./persistence/index.js";
export {
  createPersistentActor,
  InMemoryPersistenceAdapter,
  isPersistentMachine,
  makeInMemoryPersistenceAdapter,
  PersistenceAdapterTag,
  PersistenceError,
  restorePersistentActor,
  VersionConflictError,
  withPersistence,
} from "./persistence/index.js";
