// Machine namespace (Effect-style)
export * as Machine from "./machine.js";

// Slot module
export { Slot } from "./slot.js";
export type {
  GuardsSchema,
  EffectsSchema,
  GuardsDef,
  EffectsDef,
  GuardSlots,
  EffectSlots,
  GuardSlot,
  EffectSlot as SlotEffectSlot,
  GuardHandlers,
  EffectHandlers as SlotEffectHandlers,
  MachineContext,
} from "./slot.js";

// Errors
export {
  AssertionError,
  DuplicateActorError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  MissingSchemaError,
  ProvisionValidationError,
  SlotProvisionError,
  UnprovidedSlotsError,
} from "./errors.js";

// Schema-first State/Event definitions
export { State, Event } from "./schema.js";
export type { MachineStateSchema, MachineEventSchema } from "./schema.js";

// Core machine types (for advanced use)
export type {
  Machine as MachineType,
  BuiltMachine,
  MachineRef,
  MakeConfig,
  Transition,
  SpawnEffect,
  BackgroundEffect,
  PersistOptions,
  HandlerContext,
  StateHandlerContext,
  ProvideHandlers,
} from "./machine.js";

// Actor types and system
export type { ActorRef, ActorSystem } from "./actor.js";
export { ActorSystem as ActorSystemService, Default as ActorSystemDefault } from "./actor.js";

// Testing utilities
export {
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
} from "./testing.js";
export type { SimulationResult, TestHarness, TestHarnessOptions } from "./testing.js";

// Inspection
export type {
  AnyInspectionEvent,
  EffectEvent,
  ErrorEvent,
  EventReceivedEvent,
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
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  PersistenceConfig,
  PersistentActorRef,
  PersistentMachine,
  RestoreFailure,
  RestoreResult,
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
} from "./persistence/index.js";
