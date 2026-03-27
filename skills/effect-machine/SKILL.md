---
name: effect-machine
description: Type-safe state machines for Effect. Use when building state machines with effect-machine — defining states/events, transition handlers, spawn effects, timeouts, postpone, actors, testing, persistence composition. Triggers on effect-machine imports, Machine.make, Machine.spawn, Machine.replay, State/Event definitions, ActorRef usage.
---

## Navigation

```
What are you building?
├─ Defining states/events           → §Schema-First
├─ Writing transition handlers      → §Transitions
├─ Adding side effects              → §Effects
├─ Testing machines                 → §Testing
├─ Running actors                   → §Actors
├─ Persistence/restore              → §Persistence
├─ Timeouts / postpone              → §Timeouts, §Postpone
└─ Slots (guards/effects)           → §Slots
```

## Schema-First

States and events ARE schemas. `State({})` and `Event({})` produce tagged unions with constructors.

```ts
import { Schema } from "effect";
import { State, Event } from "effect-machine";

const S = State({
  Idle: {}, // empty → plain value: S.Idle
  Loading: { url: Schema.String }, // non-empty → constructor: S.Loading({ url })
});

const E = Event({
  Start: { url: Schema.String },
  Done: { data: Schema.Unknown },
});
```

**derive** — construct from existing state, picks overlapping fields:

```ts
S.Active.derive(state); // pick target fields from source
S.Active.derive(state, { count: n + 1 }); // pick + override
```

**Type guards / matching:**

```ts
S.$is("Loading")(value)                  // boolean type guard
S.$match(value, { Loading: (s) => ..., _: () => ... })  // pattern match
```

## Transitions

```ts
const machine = Machine.make({ state: S, event: E, initial: S.Idle })
  // Single state → event → handler
  .on(S.Idle, E.Start, ({ event }) => S.Loading({ url: event.url }))

  // Multi-state source
  .on([S.Loading, S.Retrying], E.Done, ({ event }) => S.Active({ data: event.data }))

  // Wildcard — any state (specific .on wins)
  .onAny(E.Cancel, () => S.Cancelled)

  // Reenter same state (re-triggers spawn effects + timeouts)
  .reenter(S.Active, E.Refresh, ({ state }) => S.Active.derive(state))

  // Mark final states (actor stops, postpone buffer settles)
  .final(S.Done)
  .final(S.Cancelled);
```

**Handler return types:**

```ts
// Pure: return new state
({ state, event }) => S.Next({ ... })

// Effectful: return Effect<State>
({ state }) => Effect.gen(function* () { ... return S.Next({ ... }) })

// With reply (for actor.ask):
({ state }) => ({ state: S.Same.derive(state), reply: state.count })
```

## Effects

### spawn — state-scoped, auto-cancelled on exit

```ts
machine.spawn(S.Loading, ({ state, self }) =>
  Effect.gen(function* () {
    const data = yield* fetchData(state.url);
    yield* self.send(E.Done({ data }));
  }),
);
```

### task — spawn + auto-route success/failure

```ts
machine.task(S.Loading, ({ state }) => fetchData(state.url), {
  onSuccess: (data) => E.Done({ data }),
  onFailure: () => E.Error,
});
```

### background — machine-lifetime (not state-scoped)

```ts
machine.background(({ self }) =>
  Stream.fromSchedule(Schedule.spaced("10 seconds")).pipe(
    Stream.runForEach(() => self.send(E.Heartbeat)),
  ),
);
```

## Slots

Guards and effects as injectable dependencies:

```ts
import { Slot } from "effect-machine";

const Guards = Slot.Guards({ canRetry: { max: Schema.Number } });
const Effects = Slot.Effects({ notify: { msg: Schema.String } });

const machine = Machine.make({
  state: S,
  event: E,
  guards: Guards,
  effects: Effects,
  initial: S.Idle,
})
  .on(S.Error, E.Retry, ({ guards, state }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) return S.Loading.derive(state);
      return S.Failed;
    }),
  )
  .spawn(S.Done, ({ effects, state }) => effects.notify({ msg: `Done: ${state.id}` }))
  .build({
    canRetry: ({ max }, { state }) => state.attempts < max,
    notify: ({ msg }) => Effect.log(msg),
  });
```

`.build()` is terminal — returns `BuiltMachine`. All slots must be provided.

## Timeouts

gen_statem-style. Timer starts on state entry, cancels on exit:

```ts
machine.timeout(S.Loading, {
  duration: Duration.seconds(30),
  event: E.Timeout,
});

// Dynamic duration from state
machine.timeout(S.Retrying, {
  duration: (state) => Duration.seconds(state.backoff),
  event: E.GiveUp,
});
```

`.reenter()` restarts the timer with fresh state values.

## Postpone

gen_statem-style. Buffered events drain FIFO on state change, looping until stable:

```ts
machine.postpone(S.Connecting, E.Data).postpone(S.Connecting, [E.Data, E.Command]);
```

Multi-stage: if a drained event causes another state change, postponed events re-drain.

## Actors

### Machine.spawn — standalone actor

```ts
const actor = yield * Machine.spawn(machine);
const actor = yield * Machine.spawn(machine, "my-id");
const actor = yield * Machine.spawn(machine, { id: "my-id", hydrate: savedState });
```

Auto-cleans up if `Scope` is present. Otherwise call `actor.stop` manually.

### ActorRef API

| Method                 | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `send(event)`          | Fire-and-forget                                                     |
| `cast(event)`          | Alias for send                                                      |
| `call(event)`          | Request-reply → `ProcessEventResult`                                |
| `ask<R>(event)`        | Typed domain reply                                                  |
| `snapshot`             | Current state                                                       |
| `changes`              | `Stream<State>` (SubscriptionRef-backed)                            |
| `transitions`          | `Stream<{ fromState, toState, event }>` (PubSub-backed edge stream) |
| `waitFor(S.X)`         | Wait for state                                                      |
| `sendAndWait(ev, S.X)` | Send + wait                                                         |
| `awaitFinal`           | Wait for final state                                                |
| `sync.*`               | Sync variants for non-Effect boundaries                             |

### ActorSystem — registry + lifecycle

```ts
const system = yield * ActorSystemService;
const actor = yield * system.spawn("id", machine); // DuplicateActorError if exists
const maybe = yield * system.get("id"); // Option<ActorRef>
yield * system.stop("id"); // boolean
system.actors; // ReadonlyMap snapshot
system.events; // Stream<SystemEvent>
```

### Child actors

```ts
machine.spawn(S.Active, ({ self }) =>
  Effect.gen(function* () {
    const child = yield* self.spawn("worker", workerMachine).pipe(Effect.orDie);
    yield* child.send(WorkerEvent.Start);
    // auto-stopped when parent exits Active
  }),
);
```

## Persistence

Composed from primitives — no built-in adapter:

```ts
// Snapshot: observe state changes
yield * actor.changes.pipe(Stream.runForEach((state) => saveSnapshot(id, state)));

// Event journal: observe transitions
yield * actor.transitions.pipe(Stream.runForEach(({ event }) => appendEvent(id, event)));

// Restore from snapshot
const actor = yield * Machine.spawn(machine, { hydrate: loadedState });

// Restore from event log
const state = yield * Machine.replay(machine, events);
const actor = yield * Machine.spawn(machine, { hydrate: state });

// Restore from snapshot + tail events
const state = yield * Machine.replay(machine, tailEvents, { from: snapshot });
const actor = yield * Machine.spawn(machine, { hydrate: state });
```

**Machine.replay semantics:**

- Folds events through transition handlers (pure or effectful)
- `self.send`/`self.spawn` are no-ops (stubbed)
- Spawn effects, background effects, timeouts do NOT run
- Postpone rules respected (loop until stable)
- Final state stops replay
- Unhandled events silently skipped

## Testing

```ts
import { simulate, assertPath, assertReaches, createTestHarness } from "effect-machine";

// Simulate — run events, get all states
const { states, finalState } = yield * simulate(machine, [E.Start, E.Done]);

// Assertions
yield * assertPath(machine, events, ["Idle", "Loading", "Done"]);
yield * assertReaches(machine, events, "Done");
yield * assertNeverReaches(machine, events, "Error");

// Test harness — step-by-step
const harness = yield * createTestHarness(machine);
yield * harness.send(E.Start);
expect(harness.state._tag).toBe("Loading");
```

Both `simulate` and `createTestHarness` accept `Machine` (unbuilt) or `BuiltMachine`.

## Gotchas

- **`.build()` is terminal** — no more `.on()` after build. Build last.
- **Empty state = value, non-empty = constructor** — `S.Idle` vs `S.Loading({ url })`
- **Spawn effects re-run on hydrate** — `Machine.spawn({ hydrate })` re-runs spawn effects for the hydrated state (timers, scoped resources)
- **`transitions` is observational** — PubSub-backed, late subscribers miss edges. Not a durability guarantee.
- **Effectful handlers in replay** — replay runs handlers but stubs `self`/`system`. Side effects through `self.send` are no-ops.
- **v3 compat** — import from `"effect-machine/v3"` for Effect v3 projects
