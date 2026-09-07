---
"effect-machine": minor
---

Allow ActorHost factories to receive typed data from the hosting parent as a second argument. Call host(request, hostInput) to bind parent input to a generation while consumers continue to call acquire(request). Existing one-argument factories keep their current behavior.
