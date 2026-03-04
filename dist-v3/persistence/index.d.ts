import {
  PersistenceConfig,
  PersistentMachine,
  isPersistentMachine,
  persist,
} from "./persistent-machine.js";
import {
  PersistentActorRef,
  createPersistentActor,
  restorePersistentActor,
} from "./persistent-actor.js";
import {
  ActorMetadata,
  PersistedEvent,
  PersistenceAdapter,
  PersistenceAdapterTag,
  PersistenceError,
  RestoreFailure,
  RestoreResult,
  Snapshot,
  VersionConflictError,
} from "./adapter.js";
import {
  InMemoryPersistenceAdapter,
  makeInMemoryPersistenceAdapter,
} from "./adapters/in-memory.js";
export {
  type ActorMetadata,
  InMemoryPersistenceAdapter,
  type PersistedEvent,
  type PersistenceAdapter,
  PersistenceAdapterTag,
  type PersistenceConfig,
  PersistenceError,
  type PersistentActorRef,
  type PersistentMachine,
  type RestoreFailure,
  type RestoreResult,
  type Snapshot,
  VersionConflictError,
  createPersistentActor,
  isPersistentMachine,
  makeInMemoryPersistenceAdapter,
  persist,
  restorePersistentActor,
};
