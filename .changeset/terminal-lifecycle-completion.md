---
"effect-machine": patch
---

Publish the terminal actor lifecycle before completing shutdown. Callers of stop and awaitExit now observe the same terminal result through lifecycle, without waiting for a detached observer task.
