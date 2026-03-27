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
  ActorStoppedError,
  AssertionError,
  DuplicateActorError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  MissingSchemaError,
  NoReplyError,
  ProvisionValidationError,
  SlotProvisionError,
  UnprovidedSlotsError,
} from "./errors.js";

// Schema-first State/Event definitions
export { State, Event } from "./schema.js";
export type { MachineStateSchema, MachineEventSchema, ReplyFields } from "./schema.js";

// Core machine types (for advanced use)
export type {
  Machine as MachineType,
  BuiltMachine,
  MachineRef,
  MakeConfig,
  Transition,
  SpawnEffect,
  BackgroundEffect,
  HandlerContext,
  StateHandlerContext,
  TaskOptions,
  ProvideHandlers,
  ReplyResult,
} from "./machine.js";

// Actor types and system
export type {
  ActorRef,
  ActorRefSync,
  ActorSystem,
  ProcessEventResult,
  SystemEvent,
  SystemEventListener,
  TransitionInfo,
} from "./actor.js";
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
  InspectorHandler,
  SpawnEvent,
  StopEvent,
  TaskEvent,
  TracingInspectorOptions,
  TransitionEvent,
} from "./inspection.js";
export {
  combineInspectors,
  collectingInspector,
  consoleInspector,
  Inspector as InspectorService,
  makeInspector,
  makeInspectorEffect,
  tracingInspector,
} from "./inspection.js";
