---
"effect-machine": minor
---

feat: remove `Scope.Scope` from `Machine.spawn` and `system.spawn` signatures

- **Scope-optional spawn**: `Machine.spawn` and `ActorSystem.spawn` no longer require `Scope.Scope` in `R`. Both detect scope via `Effect.serviceOption` — if present, attach cleanup finalizer; if absent, skip.
- **Daemon forks**: Event loop, background effects, and persistence fibers use `Effect.forkDaemon` — detached from parent scope, cleaned up by `actor.stop`.
- **System-level cleanup**: `ActorSystem` layer teardown stops all registered actors automatically. `ActorSystemDefault` is now `Layer.scoped`.
- **Breaking**: Callers that relied on `Scope.Scope` appearing in the `R` type of spawn may need type adjustments. `Effect.scoped` wrappers around spawn are no longer required but still work (scope detection finds them).
