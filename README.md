# effect-machine

Type-safe state machines for Effect. XState-inspired API with full Effect integration.

## Features

- **Schema-first** - `State` and `Event` ARE schemas. Single source of truth for types and serialization
- **Fluent builder** - Chain `.on()`, `.always()`, `.delay()` etc. with full type inference
- **Type-safe transitions** - types inferred from schemas, no manual type params needed
- **Guard composition** - `Guard.and`, `Guard.or`, `Guard.not`
- **Eventless transitions** - `always` for computed state changes
- **Delayed transitions** - `delay` with TestClock support
- **Actor model** - spawn machines as actors with lifecycle management
- **Persistence** - snapshot and event sourcing with pluggable adapters
- **Cluster support** - `toEntity` for @effect/cluster integration
- **Effect-native** - full integration with Effect runtime, layers, and testing

## Install

```bash
bun add effect-machine effect
```

## Quick Start

```typescript
import { Effect, Schema } from "effect";
import { Machine, State, Event, simulate } from "effect-machine";

// Define states with schema (schema-first - no separate type definition needed)
// Empty structs: State.Idle - plain value, not callable
// Non-empty: State.Loading({ url }) - constructor requiring args
const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Success: { data: Schema.String },
  Error: { message: Schema.String },
});
type MyState = typeof MyState.Type;

// Define events with schema
const MyEvent = Event({
  Fetch: { url: Schema.String },
  Resolve: { data: Schema.String },
  Reject: { message: Schema.String },
});
type MyEvent = typeof MyEvent.Type;

// Build machine with fluent API - types inferred from schemas
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
  .on(MyState.Loading, MyEvent.Reject, ({ event }) => MyState.Error({ message: event.message }))
  .final(MyState.Success)
  .final(MyState.Error);

// Test with simulate
Effect.runPromise(
  Effect.gen(function* () {
    const result = yield* simulate(machine, [
      MyEvent.Fetch({ url: "/api" }),
      MyEvent.Resolve({ data: "hello" }),
    ]);
    console.log(result.finalState); // Success { data: "hello" }
  }),
);
```

## State Scoping with `.from()`

Group transitions by source state:

```typescript
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .from(MyState.Idle, (s) =>
    s.on(MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  )
  .from(MyState.Loading, (s) =>
    s
      .on(MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
      .on(MyEvent.Reject, ({ event }) => MyState.Error({ message: event.message })),
  )
  .final(MyState.Success)
  .final(MyState.Error);
```

## Multi-State Transitions with `.onAny()`

Handle events from multiple states:

```typescript
machine.onAny([MyState.Loading, MyState.Success], MyEvent.Reset, () => MyState.Idle);
```

## Effect Slots

Effects (`invoke`, `onEnter`, `onExit`) use named slots. Provide handlers via `.provide()`:

```typescript
// Define machine with effect slots
const baseMachine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
  .invoke(MyState.Loading, "fetchData")
  .onEnter(MyState.Success, "notifyUser")
  .final(MyState.Success);

// Production: provide real implementations
const machine = baseMachine.provide({
  fetchData: ({ state, self }) =>
    Effect.gen(function* () {
      const data = yield* fetchFromApi(state.url);
      yield* self.send(MyEvent.Resolve({ data }));
    }),
  notifyUser: ({ state }) => Effect.log(`Success: ${state.data}`),
});

// Test: provide mock implementations
const testMachine = baseMachine.provide({
  fetchData: ({ self }) => self.send(MyEvent.Resolve({ data: "mock" })),
  notifyUser: () => Effect.void,
});
```

`simulate()` works without providing effects (pure transitions only).

## Persistence

Schemas attached to machine - no need to pass them again:

```typescript
const persistentMachine = Machine.make({
  state: OrderState,
  event: OrderEvent,
  initial: OrderState.Pending({ orderId: "" }),
})
  .on(OrderState.Pending, OrderEvent.Ship, ({ event }) =>
    OrderState.Shipped({ trackingId: event.trackingId }),
  )
  .final(OrderState.Shipped)
  .persist({
    snapshotSchedule: Schedule.forever,
    journalEvents: true,
  });
```

## Documentation

See the [primer](./primer/) for comprehensive documentation:

- [Index](./primer/index.md) - overview and navigation
- [Basics](./primer/basics.md) - core concepts
- [Combinators](./primer/combinators.md) - all combinators explained
- [Guards](./primer/guards.md) - guard composition
- [Testing](./primer/testing.md) - testing patterns
- [Actors](./primer/actors.md) - actor system

## API Overview

### Core

| Export         | Description                                    |
| -------------- | ---------------------------------------------- |
| `State({...})` | Schema-first state definition                  |
| `Event({...})` | Schema-first event definition                  |
| `Machine.make` | Create machine with `{ state, event, initial}` |

### Fluent Methods

| Method        | Description                                 |
| ------------- | ------------------------------------------- |
| `.on()`       | Add state/event transition                  |
| `.on.force()` | Transition with forced reentry              |
| `.onAny()`    | Transition from multiple states             |
| `.from()`     | Scope transitions to a source state         |
| `.always()`   | Eventless transitions with guard cascade    |
| `.choose()`   | Guard cascade for event transitions         |
| `.delay()`    | Schedule event after duration               |
| `.invoke()`   | Register invoke slot (state-scoped or root) |
| `.onEnter()`  | Register entry effect slot                  |
| `.onExit()`   | Register exit effect slot                   |
| `.provide()`  | Wire effect handlers to named slots         |
| `.final()`    | Mark state as final                         |
| `.persist()`  | Add persistence (schemas from machine)      |

### Helpers

| Export           | Description                      |
| ---------------- | -------------------------------- |
| `Machine.assign` | Helper for partial state updates |

### Guards

| Export       | Description                        |
| ------------ | ---------------------------------- |
| `Guard.make` | Create named guard slot            |
| `Guard.and`  | Combine guards with AND (parallel) |
| `Guard.or`   | Combine guards with OR (parallel)  |
| `Guard.not`  | Negate a guard                     |

Guards are **slots-only** - declare with name, provide implementation via `.provide()`:

```typescript
// Declare guard slot
const canRetry = Guard.make("canRetry");

// Composition with string shorthand
Guard.and("isAdmin", "isActive");
Guard.or("isOwner", "isAdmin");
Guard.and(Guard.or("isAdmin", "isMod"), "isActive"); // nested

// Use in transition
machine.on(State.Idle, Event.Start, () => State.Running, {
  guard: canRetry,
});

// Provide implementation (sync boolean or async Effect<boolean>)
const provided = machine.provide({
  canRetry: ({ state }) => state.retries < 3, // sync
  hasPermission: (
    { state }, // async
  ) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.check(state.userId);
    }),
});
```

### Testing

| Export              | Description                   |
| ------------------- | ----------------------------- |
| `simulate`          | Run events and get all states |
| `createTestHarness` | Step-by-step testing          |
| `assertReaches`     | Assert machine reaches state  |
| `yieldFibers`       | Yield to background fibers    |

### Actors

| Export               | Description                |
| -------------------- | -------------------------- |
| `ActorSystemService` | Actor system service tag   |
| `ActorSystemDefault` | Default actor system layer |

### Persistence

| Export                       | Description                    |
| ---------------------------- | ------------------------------ |
| `InMemoryPersistenceAdapter` | In-memory adapter for testing  |
| `PersistenceAdapterTag`      | Service tag for custom adapter |

### Cluster

| Export     | Description                                     |
| ---------- | ----------------------------------------------- |
| `toEntity` | Generate Entity from machine (schemas inferred) |

## License

MIT
