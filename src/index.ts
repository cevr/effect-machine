// Machine namespace (Effect-style)
export * as Machine from "./machine.js";

// Errors
export {
  ActorStoppedError,
  AssertionError,
  DuplicateActorError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  NoReplyError,
  PersistenceError,
  VersionConflictError,
} from "./errors.js";

// Schema-first State/Event definitions
export { State, Event } from "./schema.js";
export type { MachineStateSchema, MachineEventSchema, ReplyFields } from "./schema.js";

// Core machine types (for advanced use)
export type {
  Machine as MachineType,
  MachineRef,
  MakeConfig,
  InputMakeConfig,
  FinalContext,
  HandlerContext,
  GuardPredicate,
  StateHandlerContext,
  TaskOptions,
  TimeoutConfig,
  ReplyResult,
  DeferReplyResult,
  Recovery,
  RecoveryContext,
  Durability,
  DurabilityCommit,
  Lifecycle,
  SpawnOptions,
  ReplayOptions,
} from "./machine.js";

// Actor types and system
export type {
  ActorRef,
  ActorClient,
  ActorRefSync,
  ActorLifecycle,
  ActorSystemService as ActorSystem,
  ProcessEventResult,
  SystemEvent,
  SystemEventListener,
  TransitionInfo,
  SystemSpawnOptions,
} from "./actor.js";
export {
  actorSystemKey,
  ActorSystemKey,
  ActorSystem as ActorSystemService,
  ActorScope,
  Default as ActorSystemDefault,
} from "./actor.js";

// Supervision
export { ActorExit, Supervision } from "./supervision.js";
export type { ActorExit as ActorExitType, DefectPhase } from "./supervision.js";

// Testing utilities
export {
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  simulate,
} from "./testing.js";
export type {
  InputTestHarnessOptions,
  SimulationOptions,
  SimulationResult,
  TestHarness,
  TestHarnessOptions,
} from "./testing.js";

// Inspection
export type {
  AnyInspectionEvent,
  EffectEvent,
  ErrorEvent,
  GuardEvent,
  EventReceivedEvent,
  InspectionEvent,
  InspectorService as Inspector,
  InspectorHandler,
  OperationEvent,
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
