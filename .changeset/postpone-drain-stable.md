---
"effect-machine": patch
---

Fix multi-stage postpone drain in live actor event loop. Previously, postponed events were drained in a single pass — if a drained event caused a state change that made other postponed events runnable, they waited until the next mailbox event. Now loops until stable, matching simulate() and replay() behavior.
