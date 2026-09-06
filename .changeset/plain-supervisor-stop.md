---
"effect-machine": patch
---

Allow an actor to stop itself from protected supervised recovery. Wait for the supervisor to finish cleanup and report its cleanup defects to every stop caller.

Apply the restart policy when a restarted generation fails during startup. Continue within the retry budget and complete the actor exit when that budget ends.
