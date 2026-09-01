---
"effect-machine": patch
---

Commit synchronous client transitions before `ActorClient.send` returns and notify Actor Atom subscribers without a timer delay.
