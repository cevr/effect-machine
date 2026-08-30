# Testing

## Pure transition paths

Use `simulate` for a complete event list:

```ts
const result = yield * simulate(machine, events, { input });
expect(result.states.map((state) => state._tag)).toEqual(["Idle", "Loading", "Done"]);
```

Use `createTestHarness` when each step needs an assertion. Use `assertPath`, `assertReaches`, and `assertNeverReaches` for invariant-style tests.

Simulation and replay run pure or Effectful transition handlers. They do not run tasks, state-owned Effects, background Effects, or timeouts. Their `self` operations are inert.

## Runtime behavior

Spawn a real actor when a test covers services, tasks, child actors, persistence, supervision, inspection, or cleanup.

Provide test services through Effect:

```ts
it.scopedLive("loads the order", () => program.pipe(Effect.provide(OrderRepositoryTest)));
```

Use `TestClock` for timeouts and schedules. Use `Deferred`, `Latch`, `Queue`, `Ref`, or a test service hook for concurrent ordering. Do not use an arbitrary sleep to guess that work has started.

## UI performance

Test the public rendering behavior:

- Count component renders in React.
- Count selected reactive computations in Solid.
- Change one field at a time.
- Assert that unrelated selections do not update.
- Assert that the changed selection updates once.

The repository runs these checks in both browser example packages.
