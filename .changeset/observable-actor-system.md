---
"effect-machine": minor
---

Add observable ActorSystem with event stream and sync observation

- `system.subscribe(fn)` — sync callback for `ActorSpawned` / `ActorStopped` events, returns unsubscribe
- `system.actors` — sync snapshot of all registered actors (`ReadonlyMap`)
- `system.events` — async `Stream<SystemEvent>` via PubSub (each subscriber gets own queue)
- Works with both explicit (`ActorSystemDefault`) and implicit (`Machine.spawn`) systems
- No events emitted during system teardown
- Double-stop prevention: `system.stop` + scope finalizer won't emit duplicate `ActorStopped`
