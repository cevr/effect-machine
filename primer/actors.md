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
import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "effect-machine";

const program = Effect.gen(function* () {
  const system = yield* ActorSystemService;

  // Spawn an actor
  const actor = yield* system.spawn("my-actor", machine);

  // Use the actor...
}).pipe(Effect.scoped, Effect.provide(ActorSystemDefault));

Effect.runPromise(program);
```

**Key:** Always use `Effect.scoped` - actors are scoped resources.

## Spawning Actors

```typescript
const actor = yield * system.spawn(id, machine);
```

- `id` - Unique identifier (throws if duplicate)
- `machine` - Machine definition with effects provided
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
yield * actor.send(MyEvent.Start);
```

Events are queued and processed sequentially.

### Reading State

```typescript
// Current state
const current = yield * actor.state.get;

// Subscribe to changes
yield *
  actor.state.changes.pipe(
    Stream.tap((state) => Effect.log(`State: ${state._tag}`)),
    Stream.runDrain,
  );
```

### Stopping

```typescript
// Explicit stop
yield * actor.stop;

// Or via system
yield * system.stop("my-actor");
```

Actors also stop automatically when:

- Reaching a final state
- Scope is closed

## Multiple Actors

```typescript
const system = yield * ActorSystemService;

// Spawn multiple actors
const actor1 = yield * system.spawn("player-1", playerMachine);
const actor2 = yield * system.spawn("player-2", playerMachine);

// Communicate between actors
yield * actor1.send(MyEvent.Attack({ target: actor2.id }));
```

## Looking Up Actors

```typescript
const maybeActor = yield * system.get("player-1");

if (Option.isSome(maybeActor)) {
  yield * maybeActor.value.send(MyEvent.Heal);
}
```

## Actor Lifecycle

```
spawn() called
    │
    ▼
┌─────────────────┐
│ Initial State   │ ← spawn effects forked
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
│ Stopped         │ ← finalizers run, fibers interrupted
└─────────────────┘
```

## State Effects with spawn

Effects are forked on state entry and cancelled on exit. Use `Effect.addFinalizer` for cleanup:

```typescript
import { Machine, State, Event, Schema } from "effect-machine";

const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Success: { data: Schema.String },
});
type MyState = typeof MyState.Type;

const MyEvent = Event({
  Start: { url: Schema.String },
  Done: { data: Schema.String },
});
type MyEvent = typeof MyEvent.Type;

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Done, ({ event }) => MyState.Success({ data: event.data }))
  .spawn(MyState.Loading, ({ state, self }) =>
    Effect.gen(function* () {
      // Cleanup via finalizer
      yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));

      // Main work - auto-cancelled on state exit
      const data = yield* fetchFromApi(state.url);
      yield* self.send(MyEvent.Done({ data }));
    }),
  )
  .final(MyState.Success);
```

## spawn for Auto-Cancel

`spawn` runs an effect on entry and cancels it on exit:

```typescript
const MyState = State({
  Idle: {},
  Polling: { id: Schema.String },
});
type MyState = typeof MyState.Type;

const MyEvent = Event({
  StartPolling: { id: Schema.String },
  StatusUpdate: { status: Schema.String },
  Stop: {},
});
type MyEvent = typeof MyEvent.Type;

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.StartPolling, ({ event }) => MyState.Polling({ id: event.id }))
  .on(MyState.Polling, MyEvent.Stop, () => MyState.Idle)
  .spawn(MyState.Polling, ({ state, self }) =>
    Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("5 seconds");
        const status = yield* checkStatus(state.id);
        yield* self.send(MyEvent.StatusUpdate({ status }));
      }
    }),
  );
```

When transitioning out of `Polling`, the polling fiber is automatically interrupted.

## Testing with Actors

```typescript
test("actor processes events", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);
      yield* Effect.yieldNow(); // Let spawn effect run

      yield* actor.send(MyEvent.Start({ url: "/api" }));
      yield* Effect.yieldNow(); // Let async effects run

      const state = yield* actor.state.get;
      expect(state._tag).toBe("Loading");
    }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
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
      yield* Effect.yieldNow();

      const state = yield* actor.state.get;
      expect(state._tag).toBe("TimedOut");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
    ),
  );
});
```

## Error Handling

Unhandled errors in effects will cause the fiber to fail. Use Effect error handling:

```typescript
machine.spawn(MyState.Loading, ({ state, self }) =>
  Effect.gen(function* () {
    const result = yield* fetchFromApi(state.url).pipe(
      Effect.catchAll((error) => self.send(MyEvent.Error({ message: String(error) }))),
    );
    yield* self.send(MyEvent.Done({ data: result }));
  }),
);
```

## See Also

- `testing.md` - testing patterns
- `combinators.md` - all combinators
- `basics.md` - core concepts
