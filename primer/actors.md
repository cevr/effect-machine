# Actors

Running machines as actors with lifecycle management.

## Overview

Actors are running instances of machines with:
- Unique ID
- Event queue
- Observable state
- Automatic lifecycle (start/stop)

## Actor System

The `ActorSystem` service manages actor lifecycles.

### Setup

```typescript
import { Effect } from "effect";
import {
  ActorSystemDefault,
  ActorSystemService,
  build,
  make,
  on,
} from "effect-machine";

const program = Effect.gen(function* () {
  const system = yield* ActorSystemService;

  // Spawn an actor
  const actor = yield* system.spawn("my-actor", machine);

  // Use the actor...
}).pipe(
  Effect.scoped,
  Effect.provide(ActorSystemDefault),
);

Effect.runPromise(program);
```

**Key:** Always use `Effect.scoped` - actors are scoped resources.

## Spawning Actors

```typescript
const actor = yield* system.spawn(id, machine);
```

- `id` - Unique identifier (throws if duplicate)
- `machine` - Built machine definition
- Returns `ActorRef<State, Event>`

## ActorRef API

```typescript
interface ActorRef<State, Event> {
  // Unique ID
  id: string;

  // Send event to actor
  send: (event: Event) => Effect<void>;

  // Observable state (SubscriptionRef)
  state: SubscriptionRef<State>;

  // Stop the actor
  stop: Effect<void>;
}
```

### Sending Events

```typescript
yield* actor.send(Event.Start());
```

Events are queued and processed sequentially.

### Reading State

```typescript
// Current state
const current = yield* actor.state.get;

// Subscribe to changes
yield* actor.state.changes.pipe(
  Stream.tap((state) => Effect.log(`State: ${state._tag}`)),
  Stream.runDrain,
);
```

### Stopping

```typescript
// Explicit stop
yield* actor.stop;

// Or via system
yield* system.stop("my-actor");
```

Actors also stop automatically when:
- Reaching a final state
- Scope is closed

## Multiple Actors

```typescript
const system = yield* ActorSystemService;

// Spawn multiple actors
const actor1 = yield* system.spawn("player-1", playerMachine);
const actor2 = yield* system.spawn("player-2", playerMachine);

// Communicate between actors
yield* actor1.send(Event.Attack({ target: actor2.id }));
```

## Looking Up Actors

```typescript
const maybeActor = yield* system.get("player-1");

if (Option.isSome(maybeActor)) {
  yield* maybeActor.value.send(Event.Heal());
}
```

## Actor Lifecycle

```
spawn() called
    │
    ▼
┌─────────────────┐
│ Initial State   │ ← onEnter effects run
└────────┬────────┘
         │
    Events processed
         │
         ▼
┌─────────────────┐
│ Running         │ ← transitions + effects
└────────┬────────┘
         │
    Final state OR stop()
         │
         ▼
┌─────────────────┐
│ Stopped         │ ← onExit effects run, fibers interrupted
└─────────────────┘
```

## Entry/Exit Effects with Actors

Effects have access to `self` for sending events:

```typescript
import { onEnter, invoke } from "effect-machine";

const machine = build(
  pipe(
    make<State, Event>(State.Idle()),
    on(State.Idle, Event.Start, () => State.Loading()),
    onEnter(State.Loading, ({ state, self }) =>
      Effect.gen(function* () {
        const data = yield* fetchData(state.url);
        yield* self.send(Event.Done({ data }));
      }),
    ),
    on(State.Loading, Event.Done, ({ event }) => State.Success({ data: event.data })),
  ),
);
```

## Invoke for Auto-Cancel

`invoke` runs an effect on entry and cancels it on exit:

```typescript
const machine = build(
  pipe(
    make<State, Event>(State.Idle()),
    on(State.Idle, Event.StartPolling, () => State.Polling()),
    invoke(State.Polling, ({ state, self }) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds");
          const status = yield* checkStatus(state.id);
          yield* self.send(Event.StatusUpdate({ status }));
        }
      }),
    ),
    on(State.Polling, Event.Stop, () => State.Idle()),
  ),
);
```

When transitioning out of `Polling`, the polling fiber is automatically interrupted.

## Testing with Actors

```typescript
import { yieldFibers } from "effect-machine";

test("actor processes events", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(Event.Start());
      yield* yieldFibers; // Let async effects run

      const state = yield* actor.state.get;
      expect(state._tag).toBe("Running");
    }).pipe(
      Effect.scoped,
      Effect.provide(ActorSystemDefault),
    ),
  );
});
```

## Delays with TestClock

```typescript
import { Layer, TestClock, TestContext } from "effect";

test("delayed transition", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machineWithDelay);

      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      const state = yield* actor.state.get;
      expect(state._tag).toBe("TimedOut");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(ActorSystemDefault, TestContext.TestContext),
      ),
    ),
  );
});
```

## Error Handling

Unhandled errors in effects will cause the fiber to fail. Use Effect error handling:

```typescript
onEnter(State.Loading, ({ state, self }) =>
  Effect.gen(function* () {
    const result = yield* fetchData(state.url).pipe(
      Effect.catchAll((error) =>
        self.send(Event.Error({ message: String(error) })),
      ),
    );
    yield* self.send(Event.Done({ data: result }));
  }),
);
```

## See Also

- `testing.md` - testing patterns
- `combinators.md` - all combinators
- `basics.md` - core concepts
