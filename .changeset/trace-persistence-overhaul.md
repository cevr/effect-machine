---
"effect-machine": minor
---

Add Effect.fn tracing across actor, persistence, cluster, and testing flows. Fix persistent actor lifecycle (spawn/background effects, snapshot scheduler), restore-from-events behavior, duplicate spawn handling, and slot preflight errors. Update persistence docs; PersistentActorRef now carries environment R and replayTo runs in R.
