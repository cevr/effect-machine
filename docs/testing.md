# Testing

## Pure transition paths

Use `simulate` for a complete event list:

```ts
const result = yield * simulate(machine, events, { input });
expect(result.states.map((state) => state._tag)).toEqual(["Idle", "Loading", "Done"]);
```

Use `createTestHarness` when each step needs an assertion. Use `assertPath`, `assertReaches`, and `assertNeverReaches` for invariant-style tests.

Simulation and replay run pure or Effectful transition handlers. They do not run tasks, state-owned Effects, background Effects, or timeouts. Their `self` operations are inert.

## Machine definition

`Machine.definition(machine)` returns a frozen snapshot of every registration the machine holds. It reads the indexes the runtime selects from, so it cannot drift from runtime behavior.

- `states`: one entry per state, in schema order, including states with no registration. Each entry has `transitions` (in the order the runtime tries them), `immediate`, `effects` (spawn, task and timeout, in start order), `postponed` and `final`.
- `events`: the event tags, in schema order.
- `anyState`: the `.onAny` / `.whenAny` transitions. The runtime tries them after the state's own transitions for the same event.
- `background`: the machine-lifetime Effects.

Each entry reports the builder method and names: `handlerName` and `guardName` come from the function `name`, a task reports `options.name`, and a timeout reports `$timeout:<StateTag>`. An anonymous function reports `undefined`. An `Effect.fn` result is also anonymous: its span name is not a function name. When a test must identify a handler, use a function declaration, or a plain function or arrow assigned to a `const`.

The definition reports registrations, not targets. Handlers compute targets at run time. Use `Machine.replay` from a state to find the target of a transition.

Use it for a coverage test of state-owned event transitions: every registered state and event pair has a case, and every case names a registration. Check `anyState`, `immediate` and `effects` the same way when the test must cover them.

```ts
// One case per state/event pair: the events to replay from that state.
const cases = {
  "Idle/Start": [MyEvent.Start],
  "Loading/Done": [MyEvent.Done],
};

const registered = Machine.definition(machine).states.flatMap((state) =>
  state.transitions.map((transition) => `${state.tag}/${transition.event}`),
);
expect([...new Set(registered)].sort()).toStrictEqual(Object.keys(cases).sort());
```

Call it again after more builder calls. A snapshot does not change.

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
