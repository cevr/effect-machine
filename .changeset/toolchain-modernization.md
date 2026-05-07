---
"effect-machine": patch
---

Modernize the repository toolchain around `@effect/tsgo`, the latest Effect beta, and type-aware oxlint.

`effect` is now peer-only at runtime, v4 service tags use the `Context.Service` class form with `serviceNotAsClass` enabled, and the v3 mirror is validated through the same tsgo gate.
