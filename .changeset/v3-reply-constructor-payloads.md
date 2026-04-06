---
"effect-machine": patch
---

fix(v3): backport reply metadata stripping from event constructor payloads

`Event.reply(...)` constructor payload typing no longer leaks reply schema metadata into user payload arguments.
