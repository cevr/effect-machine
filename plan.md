# Plan

- [x] Traceable effects: replace non-`Effect.fn` effectful functions (`src/actor.ts`, `src/persistence/persistent-actor.ts`, `src/persistence/adapters/in-memory.ts`, `src/internal/inspection.ts`).
- [x] Stop semantics: add stopped refs + send no-op after stop; avoid queue shutdown races (`src/actor.ts`, `src/persistence/persistent-actor.ts`).
- [x] Persistence throughput: move journaling + metadata to background worker; event loop only enqueues (`src/persistence/persistent-actor.ts`).
- [x] Snapshot schedule completion: stop snapshots without shutting queues; keep event loop alive (`src/persistence/persistent-actor.ts`).
- [x] Spawn/restore serialization to prevent duplicate side-effects under concurrency (`src/actor.ts`).
- [x] Docs update for new semantics (send after stop no-op, persistence worker) (`primer/actors.md`, `primer/persistence.md`).

## Tests

- [x] send-after-stop is no-op (regular + persistent) (`test/actor.test.ts`, `test/persistence.test.ts`).
- [x] snapshot schedule completion doesn’t kill event loop (`test/persistence.test.ts`).
- [x] persistence worker does not block event loop (slow adapter) (`test/persistence.test.ts`).
- [x] concurrent spawn only runs effects once (`test/actor.test.ts`).
- [x] inspector exceptions don’t break loop (`test/inspection.test.ts`).

## Verify

- [x] `bun run gate`
