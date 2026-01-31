---
"effect-machine": patch
---

feat: makeInspector accepts Schema constructors as type params

`makeInspector<typeof MyState, typeof MyEvent>(cb)` now auto-extracts `.Type` from schema constructors via `ResolveType`. No need for `typeof MyState.Type` anymore.
