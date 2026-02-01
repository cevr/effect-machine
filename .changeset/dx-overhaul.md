---
"effect-machine": minor
---

feat: DX overhaul — multi-state `.on()`, `State.derive()`, `.onAny()`, `waitFor` deadlock fix, `sendSync`, `waitFor(State.X)`, `.build()` / `BuiltMachine`

- **Multi-state `.on()`/`.reenter()`**: Accept arrays of states — `.on([State.A, State.B], Event.X, handler)`
- **`State.derive()`**: Construct new state from source — `State.B.derive(stateA, { extra: val })` picks overlapping fields + applies overrides
- **`.onAny()` wildcard transitions**: Handle event from any state — `.onAny(Event.Cancel, () => State.Cancelled)`. Specific `.on()` takes priority.
- **`waitFor` deadlock fix**: Rewrote to use sync listeners + `Deferred` instead of `SubscriptionRef.changes` stream, preventing semaphore deadlock on synchronous transitions
- **`sendSync`**: Fire-and-forget sync send for framework integration (React/Solid hooks)
- **`waitFor(State.X)`**: Accept state constructor/value instead of predicate — `actor.waitFor(State.Active)` and `actor.sendAndWait(event, State.Done)`
- **`.build()` / `BuiltMachine`**: Terminal builder method — `.provide()` renamed to `.build()`, returns `BuiltMachine`. `.validate()` removed. `Machine.spawn` and `ActorSystem.spawn` accept `BuiltMachine`. No-slot machines: `.build()` with no args.
