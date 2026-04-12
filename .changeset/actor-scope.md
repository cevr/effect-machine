---
"effect-machine": minor
---

Replace ambient Scope detection with explicit ActorScope service

- `Machine.spawn` and `system.spawn` no longer attach cleanup finalizers to ambient `Scope.Scope`. This fixes a bug where unrelated scopes would unexpectedly tear down actors.
- New `ActorScope` service tag — when present in context, actors attach stop finalizers to it.
- New `Machine.scoped(effect)` helper bridges `Scope.Scope` → `ActorScope` for opt-in auto-cleanup.
- Backport `call` improvements to v3: warning log on stopped actor, complete `ProcessEventResult` fields with `satisfies` for type safety.
- Fix `bun test` tsconfig resolution and add `test:all` / v3 tests to gate.
