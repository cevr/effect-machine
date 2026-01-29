---
"effect-machine": minor
---

- send after stop is a no-op for actors and persistent actors
- async persistence worker for journaling/metadata to keep event loop fast
- snapshot schedule completion no longer stops event loop
- serialize spawn/restore to avoid duplicate side-effects under concurrency
