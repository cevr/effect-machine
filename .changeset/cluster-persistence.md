---
"effect-machine": minor
---

feat(cluster): entity persistence with snapshot and journal strategies

Add opt-in state persistence for entity-machines across deactivation/reactivation:

- **Snapshot strategy**: periodic background saves + deactivation finalizer. Simple, fast.
- **Journal strategy**: inline event append on each Send/Ask RPC, replay on reactivation. Full audit trail.
- **PersistenceAdapter** service tag with `saveSnapshot`, `loadSnapshot`, `appendEvents` (CAS), `loadEvents`
- **InMemoryPersistenceAdapter** for testing/development
- **PersistenceKey** = `{ entityType, entityId }` prevents cross-type collisions
- Journal append failures defect the entity (cluster retry restarts from last snapshot)
- Snapshot scheduler only in snapshot-only mode (prevents state/version tear in journal mode)
- v3 backport included

Also includes the cluster overhaul (runtime kernel, EntityActorRef, WatchState, self.reply, self.spawn).
