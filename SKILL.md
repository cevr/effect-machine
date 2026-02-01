# effect-machine Skill

Quick reference for AI agents working with effect-machine.

## What It Is

Type-safe state machines for Effect. Schema-first API.

## Core Pattern

```ts
import { Machine, State, Event, Slot } from "effect-machine";

// 1. Define schemas
const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Done: { data: Schema.Unknown },
});

const MyEvent = Event({
  Start: { url: Schema.String },
  Complete: { data: Schema.Unknown },
});

// 2. Build machine
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Complete, ({ event }) => MyState.Done({ data: event.data }))
  .final(MyState.Done);
```

## Key Methods

| Method                            | Purpose                                                     |
| --------------------------------- | ----------------------------------------------------------- |
| `.on(state, event, handler)`      | Add transition                                              |
| `.on([stateA, stateB], event, h)` | Multi-state transition                                      |
| `.onAny(event, handler)`          | Wildcard (any state, specific .on wins)                     |
| `.reenter(state, event, handler)` | Force lifecycle on same-state                               |
| `.spawn(state, handler)`          | State-scoped effect (auto-cancelled)                        |
| `.background(handler)`            | Machine-lifetime effect                                     |
| `.final(state)`                   | Mark final state                                            |
| `.build({ slot: impl })`          | Wire implementations, returns `BuiltMachine` (terminal)     |
| `.build()`                        | Finalize no-slot machine, returns `BuiltMachine` (terminal) |
| `.persist(config)`                | Enable persistence                                          |

## State.derive()

Construct state from existing source:

```ts
// Same-state: preserve fields, override specific ones
State.Active.derive(state, { count: state.count + 1 });

// Cross-state: picks only target fields
State.Shipped.derive(processingState, { trackingId: "TRACK-123" });

// Empty variant
State.Idle.derive(anyState); // → { _tag: "Idle" }
```

## Slots (Guards/Effects)

```ts
const Guards = Slot.Guards({ canRetry: { max: Schema.Number } });
const Effects = Slot.Effects({ fetch: { url: Schema.String } });

machine
  .on(State.X, Event.Y, ({ guards, effects }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        yield* effects.fetch({ url: "/api" });
      }
      return State.Z;
    }),
  )
  .build({
    canRetry: ({ max }, { state }) => state.attempts < max,
    fetch: ({ url }, { self }) => Http.get(url),
  });
```

## Running Actors

**Simple (no registry):**

```ts
const program = Effect.gen(function* () {
  const actor = yield* Machine.spawn(machine);
  yield* actor.send(Event.Start({ url: "/api" }));
  const state = yield* actor.waitFor(MyState.Done);
});

Effect.runPromise(Effect.scoped(program));
```

**With registry/persistence:**

```ts
const program = Effect.gen(function* () {
  const system = yield* ActorSystemService;
  const actor = yield* system.spawn("id", machine);
  // ...
});

Effect.runPromise(Effect.scoped(program.pipe(Effect.provide(ActorSystemDefault))));
```

## ActorRef API

| Method                           | Description                        |
| -------------------------------- | ---------------------------------- |
| `actor.send(event)`              | Queue event (Effect)               |
| `actor.sendSync(event)`          | Fire-and-forget (sync, for UI)     |
| `actor.waitFor(State.X)`         | Wait for state (constructor or fn) |
| `actor.sendAndWait(ev, State.X)` | Send + wait for state              |
| `actor.awaitFinal`               | Wait for final state               |
| `actor.snapshot`                 | Get current state                  |
| `actor.snapshotSync()`           | Get current state (sync)           |
| `actor.matches(tag)`             | Check state tag                    |
| `actor.subscribe(fn)`            | Sync callback, returns unsubscribe |

## Testing

```ts
// Simulate (no spawn effects)
const result = yield * simulate(machine, [Event.Start, Event.Complete]);
expect(result.finalState._tag).toBe("Done");

// Assert path
yield * assertPath(machine, events, ["Idle", "Loading", "Done"]);

// Real actor (with spawn effects)
const actor = yield * system.spawn("test", machine);
yield * actor.send(Event.Start);
yield * Effect.yieldNow();
yield * TestClock.adjust("30 seconds"); // For timeouts
```

## Critical Gotchas

1. **Empty structs are values**: `State.Idle` not `State.Idle()`
2. **yield after send**: `yield* Effect.yieldNow()` to process events
3. **simulate skips spawn**: Use real actors for spawn effect tests
4. **Same-state skips lifecycle**: Use `.reenter()` to force
5. **Never throw in Effect.gen**: Use `yield* Effect.fail()`
6. **`.onAny()` is fallback**: Specific `.on()` always takes priority
7. **`.build()` is terminal**: No chaining `.on()`, `.final()` after it

## Files

| File         | Purpose                  |
| ------------ | ------------------------ |
| `machine.ts` | Machine builder          |
| `schema.ts`  | State/Event + derive     |
| `slot.ts`    | Slot.Guards/Slot.Effects |
| `actor.ts`   | ActorSystem, event loop  |
| `testing.ts` | simulate, harness        |

## See Also

- `primer/` - Full documentation
- `CODEMAP.md` - Codebase structure
