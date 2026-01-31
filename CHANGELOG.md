# effect-machine

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
