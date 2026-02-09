---
"effect-machine": minor
---

Add observable ActorSystem and wire up actor.children for persistent actors

**ActorSystem observation:**

- `system.subscribe(fn)` — sync callback for `ActorSpawned` / `ActorStopped` events, returns unsubscribe
- `system.actors` — sync snapshot of all registered actors (`ReadonlyMap`)
- `system.events` — async `Stream<SystemEvent>` via PubSub (each subscriber gets own queue)
- Works with both explicit (`ActorSystemDefault`) and implicit (`Machine.spawn`) systems
- No events emitted during system teardown
- Double-stop prevention: `system.stop` + scope finalizer won't emit duplicate `ActorStopped`

**actor.children:**

- Wire up `childrenMap` in persistent actors so `actor.children` reflects `self.spawn` children
- Children auto-removed from map on scope close (state-scoped cleanup)
