---
"effect-machine": patch
---

Construct schema-tagged errors through `.make` instead of `new`, model finite numeric schema fields with `Schema.Finite`, and route an unhandled `NoReplyError` in the cluster entity loop through `Effect.orDie`.
