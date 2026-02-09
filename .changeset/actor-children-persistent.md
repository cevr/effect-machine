---
"effect-machine": minor
---

Add actor.children to expose child actors spawned via self.spawn

- `actor.children` returns `ReadonlyMap<string, ActorRef>` of children spawned via `self.spawn`
- State-scoped children auto-removed from map on state exit
- Works for both regular and persistent actors
