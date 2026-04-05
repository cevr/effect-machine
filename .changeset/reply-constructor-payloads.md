---
"effect-machine": patch
---

Fix `Event.reply(...)` constructor payload typing so reply schema metadata does not leak into user payload arguments.

Add regressions for:

- payload-bearing reply event constructors accepting plain payload objects
- `ask()` with payload-bearing reply events
