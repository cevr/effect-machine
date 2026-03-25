---
"effect-machine": minor
---

Add `dispatch` and `dispatchPromise` to ActorRef — synchronous event processing with transition receipts.

**`dispatch(event)`** — Effect-based. Sends event through the queue (preserving serialization) and returns `ProcessEventResult<State>` with `{ transitioned, previousState, newState, lifecycleRan, isFinal }`. OTP `gen_server:call` equivalent.

**`dispatchPromise(event)`** — Promise-based. Same semantics as `dispatch` for use at non-Effect boundaries (React event handlers, framework hooks, tests).

Also exports `ProcessEventResult` from the public API.
