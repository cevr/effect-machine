---
"effect-machine": patch
---

Add `AnyInspectionEvent` type alias and default generic params on `makeInspector`/`consoleInspector`/`collectingInspector` so untyped inspectors work without explicit casts.
