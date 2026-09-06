---
"effect-machine": patch
---

Coordinate actor shutdown through one shared completion. Concurrent and repeated stops now wait for runtime, child, and scope finalizers. Cleanup defects remain visible as `ActorExit.Defect` with phase `cleanup`.
