---
"effect-machine": minor
---

Add ActorHost for lazy actors owned by a parent state scope. Consumers share startup without owning cancellation or shutdown. The factory captures service dependencies, uses the first matching request input, and releases the actor on state exit or host service shutdown.
