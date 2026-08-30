---
"effect-machine": minor
---

Move the package to Effect 4 RC.

Remove Effect 3 compatibility and the Slot API.

Let task, spawn, and background handlers require native Effect services.

Capture provided services when an actor is allocated so a later start keeps the same context.
