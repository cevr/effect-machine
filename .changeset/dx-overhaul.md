---
"effect-machine": minor
---

feat: DX overhaul — multi-state `.on()`, `State.derive()`, `.onAny()`, `waitFor` deadlock fix, `sendSync`, `waitFor(State.X)`, `.validate()`

- **Multi-state `.on()`/`.reenter()`**: Accept arrays of states — `.on([State.A, State.B], Event.X, handler)`
- **`State.derive()`**: Construct new state from source — `State.B.derive(stateA, { extra: val })` picks overlapping fields + applies overrides
- **`.onAny()` wildcard transitions**: Handle event from any state — `.onAny(Event.Cancel, () => State.Cancelled)`. Specific `.on()` takes priority.
- **`waitFor` deadlock fix**: Rewrote to use sync listeners + `Deferred` instead of `SubscriptionRef.changes` stream, preventing semaphore deadlock on synchronous transitions
- **`sendSync`**: Fire-and-forget sync send for framework integration (React/Solid hooks)
- **`waitFor(State.X)`**: Accept state constructor/value instead of predicate — `actor.waitFor(State.Active)` and `actor.sendAndWait(event, State.Done)`
- **`.validate()`**: Early slot validation — `machine.provide({...}).validate()` throws `UnprovidedSlotsError` immediately instead of at spawn time
