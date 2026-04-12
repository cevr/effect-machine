---
"effect-machine": major
---

Upgrade to effect 4.0.0-beta.47, require tsgo for type checking

**Breaking:** Minimum peer dependency is now `effect@>=4.0.0-beta.47`. The `ServiceMap` module was removed upstream — all `ServiceMap.Service` usages are now `Context.Service`.

- Rename `ServiceMap.Service` → `Context.Service` throughout
- Rename `Effect.services()` → `Effect.context()`
- Switch type checker from `tsc` to `tsgo` (native Go compiler via `@typescript/native-preview`)
- Switch Effect LSP from tsconfig plugin patch to `effect-language-service diagnostics` CLI
- Simplify tsconfig.json for TypeScript 6 defaults
