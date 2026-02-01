# effect-machine

## 0.3.1

### Patch Changes

- Add `stopSync` to `ActorRef` — fire-and-forget stop for sync contexts (framework cleanup hooks, event handlers).

## 0.3.0

### Minor Changes

- [`0154ac9`](https://github.com/cevr/effect-machine/commit/0154ac910aed5b8ac456ba7194b6be25f8d640d4) Thanks [@cevr](https://github.com/cevr)! - feat: DX overhaul — multi-state `.on()`, `State.derive()`, `.onAny()`, `waitFor` deadlock fix, `sendSync`, `waitFor(State.X)`, `.build()` / `BuiltMachine`
  - **Multi-state `.on()`/`.reenter()`**: Accept arrays of states — `.on([State.A, State.B], Event.X, handler)`
  - **`State.derive()`**: Construct new state from source — `State.B.derive(stateA, { extra: val })` picks overlapping fields + applies overrides
  - **`.onAny()` wildcard transitions**: Handle event from any state — `.onAny(Event.Cancel, () => State.Cancelled)`. Specific `.on()` takes priority.
  - **`waitFor` deadlock fix**: Rewrote to use sync listeners + `Deferred` instead of `SubscriptionRef.changes` stream, preventing semaphore deadlock on synchronous transitions
  - **`sendSync`**: Fire-and-forget sync send for framework integration (React/Solid hooks)
  - **`waitFor(State.X)`**: Accept state constructor/value instead of predicate — `actor.waitFor(State.Active)` and `actor.sendAndWait(event, State.Done)`
  - **`.build()` / `BuiltMachine`**: Terminal builder method — `.provide()` renamed to `.build()`, returns `BuiltMachine`. `.validate()` removed. `Machine.spawn` and `ActorSystem.spawn` accept `BuiltMachine`. No-slot machines: `.build()` with no args.

- [`365da12`](https://github.com/cevr/effect-machine/commit/365da129e6875ebd9dc2b68f8b0873aab90f42cf) Thanks [@cevr](https://github.com/cevr)! - feat: remove `Scope.Scope` from `Machine.spawn` and `system.spawn` signatures
  - **Scope-optional spawn**: `Machine.spawn` and `ActorSystem.spawn` no longer require `Scope.Scope` in `R`. Both detect scope via `Effect.serviceOption` — if present, attach cleanup finalizer; if absent, skip.
  - **Daemon forks**: Event loop, background effects, and persistence fibers use `Effect.forkDaemon` — detached from parent scope, cleaned up by `actor.stop`.
  - **System-level cleanup**: `ActorSystem` layer teardown stops all registered actors automatically. `ActorSystemDefault` is now `Layer.scoped`.
  - **Breaking**: Callers that relied on `Scope.Scope` appearing in the `R` type of spawn may need type adjustments. `Effect.scoped` wrappers around spawn are no longer required but still work (scope detection finds them).

## 0.2.4

### Patch Changes

- [`d29f2ff`](https://github.com/cevr/effect-machine/commit/d29f2ff77af15f021884227042032cf5b46e9219) Thanks [@cevr](https://github.com/cevr)! - feat: makeInspector accepts Schema constructors as type params

  `makeInspector<typeof MyState, typeof MyEvent>(cb)` now auto-extracts `.Type` from schema constructors via `ResolveType`. No need for `typeof MyState.Type` anymore.

## 0.2.3

### Patch Changes

- [`85a2854`](https://github.com/cevr/effect-machine/commit/85a285401e9643710dd965bc376112bfaa7bdf33) Thanks [@cevr](https://github.com/cevr)! - fix: use forkScoped for event loop fiber to prevent premature interruption

  Changed `Effect.fork` to `Effect.forkScoped` for the actor event loop fiber. Previously, the event loop was attached to the calling fiber's scope, meaning it would be interrupted when a transient caller completed. Now the event loop's lifetime is tied to the provided `Scope.Scope` service, allowing callers to control the actor's lifecycle explicitly.

## 0.2.2

### Patch Changes

- [`2bcb0bb`](https://github.com/cevr/effect-machine/commit/2bcb0bbbb070c8f35cc9253aee3206140b8b35ae) Thanks [@cevr](https://github.com/cevr)! - Add `AnyInspectionEvent` type alias and default generic params on `makeInspector`/`consoleInspector`/`collectingInspector` so untyped inspectors work without explicit casts.

- [`c50c3ce`](https://github.com/cevr/effect-machine/commit/c50c3ce64207e8dea38d8d40a31de56e3a5549a7) Thanks [@cevr](https://github.com/cevr)! - Fix `waitFor` race condition where a fast state transition between `get` and `changes` subscription could cause `waitFor` to hang forever. Now uses `stateRef.changes` directly which emits the current value atomically as its first element.

## 0.2.1

### Patch Changes

- [`639ee87`](https://github.com/cevr/effect-machine/commit/639ee8731f91a23b2c6be4a68a2f7b0a7cee8bee) Thanks [@cevr](https://github.com/cevr)! - Fix PersistenceAdapterTag key for deterministic key diagnostics and align language-service config.

## 0.2.0

### Minor Changes

- [`f4a8c8f`](https://github.com/cevr/effect-machine/commit/f4a8c8f56bcc2d680d1d97c86d99e5c6a42dd2f5) Thanks [@cevr](https://github.com/cevr)! - - send after stop is a no-op for actors and persistent actors
  - async persistence worker for journaling/metadata to keep event loop fast
  - snapshot schedule completion no longer stops event loop
  - serialize spawn/restore to avoid duplicate side-effects under concurrency

- [`a77f9fa`](https://github.com/cevr/effect-machine/commit/a77f9fa117be89231b1a16db62c9793caa035091) Thanks [@cevr](https://github.com/cevr)! - Add Machine.task, ActorRef wait/await helpers, and error inspection events.

- [`3172971`](https://github.com/cevr/effect-machine/commit/31729717c653969aa158dd887248912c817cbe50) Thanks [@cevr](https://github.com/cevr)! - Add Effect.fn tracing across actor, persistence, cluster, and testing flows. Fix persistent actor lifecycle (spawn/background effects, snapshot scheduler), restore-from-events behavior, duplicate spawn handling, and slot preflight errors. Update persistence docs; PersistentActorRef now carries environment R and replayTo runs in R.
