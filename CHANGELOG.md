# effect-machine

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
