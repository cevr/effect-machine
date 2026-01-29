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

| Method                            | Purpose                              |
| --------------------------------- | ------------------------------------ |
| `.on(state, event, handler)`      | Add transition                       |
| `.reenter(state, event, handler)` | Force lifecycle on same-state        |
| `.spawn(state, handler)`          | State-scoped effect (auto-cancelled) |
| `.background(handler)`            | Machine-lifetime effect              |
| `.provide({ slot: impl })`        | Wire slot implementations            |
| `.final(state)`                   | Mark final state                     |
| `.persist(config)`                | Enable persistence                   |

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
  .provide({
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
  yield* Effect.yieldNow();
  const state = yield* actor.snapshot;
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

## Files

| File         | Purpose                  |
| ------------ | ------------------------ |
| `machine.ts` | Machine builder          |
| `schema.ts`  | State/Event factories    |
| `slot.ts`    | Slot.Guards/Slot.Effects |
| `actor.ts`   | ActorSystem, event loop  |
| `testing.ts` | simulate, harness        |

## See Also

- `primer/` - Full documentation
- `CODEMAP.md` - Codebase structure
