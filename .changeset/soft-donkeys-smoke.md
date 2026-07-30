---
"effect-machine": patch
---

Validate slot codecs through the Effect error channel and route inspector callbacks through `Effect.try`, so schema mismatches and throwing inspectors no longer rely on `try`/`catch`.
