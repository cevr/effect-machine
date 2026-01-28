# effect-machine

Type-safe state machines for Effect. XState-inspired API with full Effect integration.

## Features

- **Schema-first** - `State` and `Event` ARE schemas. Single source of truth for types and serialization
- **Fluent builder** - Chain `.on()`, `.spawn()`, `.background()` etc. with full type inference
- **Type-safe transitions** - types inferred from schemas, no manual type params needed
- **Guard composition** - `Guard.and`, `Guard.or`, `Guard.not`
- **State-scoped effects** - spawn effects auto-cancelled on state exit (timeouts, polling, etc.)
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

## State Effects with spawn

Use `.spawn()` for state-scoped effects. Spawn handlers call effect slots defined via `Slot.Effects`:

```typescript
const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
  heartbeat: {},
});

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  effects: MyEffects,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
  // Spawn calls effect slot - logic lives in provide()
  .spawn(MyState.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  // Background calls effect slot - no name parameter
  .background(({ effects }) => effects.heartbeat())
  .provide({
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
        const data = yield* fetchFromApi(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
    heartbeat: (_, { self }) =>
      Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(MyEvent.Ping)))),
  })
  .final(MyState.Success);
```

`simulate()` works without spawn/background effects (pure transitions only).

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

| Method          | Description                                      |
| --------------- | ------------------------------------------------ |
| `.on()`         | Add state/event transition                       |
| `.reenter()`    | Transition with forced reentry (runs exit/enter) |
| `.spawn()`      | State-scoped effect (cancelled on exit)          |
| `.background()` | Machine-lifetime effect                          |
| `.provide()`    | Wire handlers to guard/effect slots              |
| `.final()`      | Mark state as final                              |
| `.persist()`    | Add persistence (schemas from machine)           |

### Guards

| Export        | Description                        |
| ------------- | ---------------------------------- |
| `Slot.Guards` | Define guard slots with params     |
| `Guard.and`   | Combine guards with AND (parallel) |
| `Guard.or`    | Combine guards with OR (parallel)  |
| `Guard.not`   | Negate a guard                     |

Guards are **slots-only** - declare with schema params, provide implementation via `.provide()`:

```typescript
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number },
});

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards,
  initial: MyState.Idle,
})
  .on(MyState.Error, MyEvent.Retry, ({ state, guards }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        return MyState.Retrying;
      }
      return MyState.Failed;
    }),
  )
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max,
  });
```

### Testing

| Export              | Description                   |
| ------------------- | ----------------------------- |
| `simulate`          | Run events and get all states |
| `createTestHarness` | Step-by-step testing          |
| `assertReaches`     | Assert machine reaches state  |

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
