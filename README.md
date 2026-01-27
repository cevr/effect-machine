# effect-machine

Type-safe state machines for Effect. XState-inspired API with full Effect integration.

## Features

- **Type-safe transitions** - branded `State<T>` and `Event<T>` types prevent mixups at compile time
- **Guard composition** - `Guard.and`, `Guard.or`, `Guard.not`
- **Eventless transitions** - `always` for computed state changes
- **Delayed transitions** - `delay` with TestClock support
- **Actor model** - spawn machines as actors with lifecycle management
- **Persistence** - snapshot and event sourcing with pluggable adapters
- **Effect-native** - full integration with Effect runtime, layers, and testing

## Install

```bash
bun add effect-machine effect
```

## Quick Start

```typescript
import { Effect } from "effect";
import { Machine, State, Event, simulate } from "effect-machine";

// Define states with branded types
type MyState = State<{
  Idle: {};
  Loading: { url: string };
  Success: { data: string };
  Error: { message: string };
}>;
const MyState = State<MyState>();

// Define events with branded types
type MyEvent = Event<{
  Fetch: { url: string };
  Resolve: { data: string };
  Reject: { message: string };
}>;
const MyEvent = Event<MyEvent>();

// Build machine using namespace
const machine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  Machine.on(MyState.Loading, MyEvent.Resolve, ({ event }) =>
    MyState.Success({ data: event.data }),
  ),
  Machine.on(MyState.Loading, MyEvent.Reject, ({ event }) =>
    MyState.Error({ message: event.message }),
  ),
  Machine.final(MyState.Success),
  Machine.final(MyState.Error),
  Machine.build,
);

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

## State Scoping with `Machine.from`

Group transitions by source state:

```typescript
const machine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.from(MyState.Idle).pipe(
    Machine.on(MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  ),
  Machine.from(MyState.Loading).pipe(
    Machine.on(MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data })),
    Machine.on(MyEvent.Reject, ({ event }) => MyState.Error({ message: event.message })),
  ),
  Machine.final(MyState.Success),
  Machine.final(MyState.Error),
  Machine.build,
);
```

## Multi-State Transitions with `Machine.any`

Handle events from multiple states:

```typescript
Machine.on(Machine.any(MyState.Loading, MyState.Success), MyEvent.Reset, () => MyState.Idle());
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

| Export          | Description                               |
| --------------- | ----------------------------------------- |
| `State<T>`      | Branded state type and constructor        |
| `Event<T>`      | Branded event type and constructor        |
| `Machine.make`  | Create machine builder with initial state |
| `Machine.build` | Finalize machine definition               |
| `Machine.on`    | Add state/event transition                |
| `Machine.final` | Mark state as final                       |

### Combinators

| Export            | Description                               |
| ----------------- | ----------------------------------------- |
| `Machine.from`    | Scope transitions to a source state       |
| `Machine.any`     | Match multiple states for transitions     |
| `Machine.always`  | Eventless transitions with guard cascade  |
| `Machine.choose`  | Guard cascade for event transitions       |
| `Machine.delay`   | Schedule event after duration             |
| `Machine.assign`  | Helper for partial state updates          |
| `Machine.update`  | Shorthand for `on` + `assign`             |
| `Machine.invoke`  | Run effect on state entry, cancel on exit |
| `Machine.onEnter` | Run effect on state entry                 |
| `Machine.onExit`  | Run effect on state exit                  |

### Guards

| Export       | Description             |
| ------------ | ----------------------- |
| `Guard.make` | Create reusable guard   |
| `Guard.and`  | Combine guards with AND |
| `Guard.or`   | Combine guards with OR  |
| `Guard.not`  | Negate a guard          |

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
| `withPersistence`            | Add persistence to a machine   |
| `InMemoryPersistenceAdapter` | In-memory adapter for testing  |
| `PersistenceAdapterTag`      | Service tag for custom adapter |

## License

MIT
