// Core types
export type {
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  RestoreFailure,
  RestoreResult,
  Snapshot,
} from "./adapter.js";
export { PersistenceAdapterTag, PersistenceError, VersionConflictError } from "./adapter.js";

// Persistent machine
export type { PersistenceConfig, PersistentMachine } from "./persistent-machine.js";
export { isPersistentMachine, withPersistence } from "./persistent-machine.js";

// Persistent actor
export type { PersistentActorRef } from "./persistent-actor.js";
export { createPersistentActor, restorePersistentActor } from "./persistent-actor.js";

// Adapters
export {
  InMemoryPersistenceAdapter,
  makeInMemoryPersistenceAdapter,
} from "./adapters/in-memory.js";
