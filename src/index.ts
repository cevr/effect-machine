// Machine namespace (Effect-style)
export * as Machine from "./namespace.js";

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
  GuardProvisionError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  MissingSchemaError,
  MissingSlotHandlerError,
  ProvisionValidationError,
  SlotProvisionError,
  UnknownSlotError,
  UnprovidedSlotsError,
} from "./errors.js";

// Schema-first State/Event definitions
export { State, Event } from "./machine-schema.js";
export type { MachineStateSchema, MachineEventSchema } from "./machine-schema.js";

// Core machine types (for advanced use)
export type {
  Machine as MachineType,
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

// Actor types
export type { ActorRef } from "./actor-ref.js";

// Actor system
export type { ActorSystem } from "./actor-system.js";
export {
  ActorSystem as ActorSystemService,
  Default as ActorSystemDefault,
} from "./actor-system.js";

// Testing utilities
export {
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
} from "./testing.js";
export type { SimulationResult, TestHarness, TestHarnessOptions } from "./testing.js";

// Internal types for handlers
export type { InstanceOf, StateEffectContext } from "./internal/types.js";

// Inspection
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
