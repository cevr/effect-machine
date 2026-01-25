# effect-machine

Type-safe state machines for Effect. XState-inspired API with full Effect integration.

## Features

- **Type-safe transitions** - states and events are tagged enums
- **Guard composition** - `Guard.and`, `Guard.or`, `Guard.not`
- **Eventless transitions** - `always` for computed state changes
- **Delayed transitions** - `delay` with TestClock support
- **Actor model** - spawn machines as actors with lifecycle management
- **Effect-native** - full integration with Effect runtime, layers, and testing

## Install

```bash
bun add effect-machine effect
```

## Quick Start

```typescript
import { Data, Effect, pipe } from "effect";
import { build, final, make, on, simulate } from "effect-machine";

// Define states
type State = Data.TaggedEnum<{
  Idle: {};
  Loading: { url: string };
  Success: { data: string };
  Error: { message: string };
}>;
const State = Data.taggedEnum<State>();

// Define events
type Event = Data.TaggedEnum<{
  Fetch: { url: string };
  Resolve: { data: string };
  Reject: { message: string };
}>;
const Event = Data.taggedEnum<Event>();

// Build machine
const machine = build(
  pipe(
    make<State, Event>(State.Idle()),
    on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
    on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
    on(State.Loading, Event.Reject, ({ event }) => State.Error({ message: event.message })),
    final(State.Success),
    final(State.Error),
  ),
);

// Test with simulate
Effect.runPromise(
  Effect.gen(function* () {
    const result = yield* simulate(machine, [
      Event.Fetch({ url: "/api" }),
      Event.Resolve({ data: "hello" }),
    ]);
    console.log(result.finalState); // Success { data: "hello" }
  }),
);
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

| Export | Description |
|--------|-------------|
| `make` | Create machine builder with initial state |
| `build` | Finalize machine definition |
| `on` | Add state/event transition |
| `final` | Mark state as final |

### Combinators

| Export | Description |
|--------|-------------|
| `always` | Eventless transitions with guard cascade |
| `choose` | Guard cascade for event transitions |
| `delay` | Schedule event after duration |
| `assign` | Helper for partial state updates |
| `update` | Shorthand for `on` + `assign` |
| `invoke` | Run effect on state entry, cancel on exit |
| `onEnter` | Run effect on state entry |
| `onExit` | Run effect on state exit |

### Guards

| Export | Description |
|--------|-------------|
| `Guard.make` | Create reusable guard |
| `Guard.and` | Combine guards with AND |
| `Guard.or` | Combine guards with OR |
| `Guard.not` | Negate a guard |

### Testing

| Export | Description |
|--------|-------------|
| `simulate` | Run events and get all states |
| `createTestHarness` | Step-by-step testing |
| `assertReaches` | Assert machine reaches state |
| `yieldFibers` | Yield to background fibers |

### Actors

| Export | Description |
|--------|-------------|
| `ActorSystemService` | Actor system service tag |
| `ActorSystemDefault` | Default actor system layer |

## License

MIT
