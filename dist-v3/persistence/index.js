import { isPersistentMachine, persist } from "./persistent-machine.js";
import { PersistenceAdapterTag, PersistenceError, VersionConflictError } from "./adapter.js";
import { createPersistentActor, restorePersistentActor } from "./persistent-actor.js";
import {
  InMemoryPersistenceAdapter,
  makeInMemoryPersistenceAdapter,
} from "./adapters/in-memory.js";

export {
  InMemoryPersistenceAdapter,
  PersistenceAdapterTag,
  PersistenceError,
  VersionConflictError,
  createPersistentActor,
  isPersistentMachine,
  makeInMemoryPersistenceAdapter,
  persist,
  restorePersistentActor,
};
