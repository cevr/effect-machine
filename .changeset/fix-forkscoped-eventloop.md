---
"effect-machine": patch
---

fix: use forkScoped for event loop fiber to prevent premature interruption

Changed `Effect.fork` to `Effect.forkScoped` for the actor event loop fiber. Previously, the event loop was attached to the calling fiber's scope, meaning it would be interrupted when a transient caller completed. Now the event loop's lifetime is tied to the provided `Scope.Scope` service, allowing callers to control the actor's lifecycle explicitly.
