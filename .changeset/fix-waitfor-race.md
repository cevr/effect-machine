---
"effect-machine": patch
---

Fix `waitFor` race condition where a fast state transition between `get` and `changes` subscription could cause `waitFor` to hang forever. Now uses `stateRef.changes` directly which emits the current value atomically as its first element.
