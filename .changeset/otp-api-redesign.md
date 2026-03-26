---
"effect-machine": minor
---

OTP-inspired API redesign:

- rename dispatch→call, add cast alias for send
- extract sync helpers to actor.sync.\* namespace
- add ask() for typed domain replies from handlers
- add .timeout() for gen_statem-style state timeouts
- add .postpone() for gen_statem-style event postpone
- fix reply settlement (ActorStoppedError on stop/interrupt)

Breaking: removed top-level sync methods (sendSync, stopSync, etc.), removed dispatchPromise.
