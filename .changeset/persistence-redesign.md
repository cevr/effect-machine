---
"effect-machine": major
---

Delete monolithic persistence subsystem, add composable primitives.

**Added:**

- `Machine.replay(built, events, { from? })` — fold events through transition handlers to compute state. Respects postpone rules and final-state cutoff. Runs effectful handlers with stubbed self/system.
- `actor.transitions` — PubSub-backed stream of `{ fromState, toState, event }` on every successful transition. Observational, not a durability guarantee.

**Removed:**

- `PersistenceAdapter`, `PersistenceAdapterTag`, `PersistenceError`, `VersionConflictError`
- `PersistentMachine`, `PersistentActorRef`, `PersistenceConfig`
- `createPersistentActor`, `restorePersistentActor`, `isPersistentMachine`
- `InMemoryPersistenceAdapter`, `makeInMemoryPersistenceAdapter`
- `Machine.persist()`, `BuiltMachine.persist()`
- `ActorSystem.restore`, `ActorSystem.restoreMany`, `ActorSystem.restoreAll`, `ActorSystem.listPersisted`

**Migration:** Compose persistence from primitives:

- Snapshot: `actor.changes` → save to your store
- Event journal: `actor.transitions` → append events
- Restore from snapshot: `Machine.spawn(machine, { hydrate: loadedState })`
- Restore from events: `Machine.replay(machine, events)` → `Machine.spawn(machine, { hydrate: state })`
