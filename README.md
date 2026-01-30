# effect-machine

Type-safe state machines for Effect.

## Why State Machines?

State machines eliminate entire categories of bugs:

- **No invalid states** - Compile-time enforcement of valid transitions
- **Explicit side effects** - Effects scoped to states, auto-cancelled on exit
- **Testable** - Simulate transitions without actors, assert paths deterministically
- **Serializable** - Schemas power persistence and cluster distribution

## Install

```bash
bun add effect-machine effect
# or
pnpm add effect-machine effect
# or
npm install effect-machine effect
```

## Quick Example

```ts
import { Effect, Schema } from "effect";
import { Machine, State, Event, Slot } from "effect-machine";

// Define state schema - states ARE schemas
const OrderState = State({
  Pending: { orderId: Schema.String },
  Processing: { orderId: Schema.String },
  Shipped: { trackingId: Schema.String },
  Cancelled: {},
});

// Define event schema
const OrderEvent = Event({
  Process: {},
  Ship: { trackingId: Schema.String },
  Cancel: {},
});

// Define effects (side effects scoped to states)
const OrderEffects = Slot.Effects({
  notifyWarehouse: { orderId: Schema.String },
});

// Build machine with fluent API
const orderMachine = Machine.make({
  state: OrderState,
  event: OrderEvent,
  effects: OrderEffects,
  initial: OrderState.Pending({ orderId: "order-1" }),
})
  .on(OrderState.Pending, OrderEvent.Process, ({ state }) =>
    OrderState.Processing({ orderId: state.orderId }),
  )
  .on(OrderState.Processing, OrderEvent.Ship, ({ event }) =>
    OrderState.Shipped({ trackingId: event.trackingId }),
  )
  .on(OrderState.Pending, OrderEvent.Cancel, () => OrderState.Cancelled)
  .on(OrderState.Processing, OrderEvent.Cancel, () => OrderState.Cancelled)
  // Effect runs when entering Processing, cancelled on exit
  .spawn(OrderState.Processing, ({ effects, state }) =>
    effects.notifyWarehouse({ orderId: state.orderId }),
  )
  .provide({
    notifyWarehouse: ({ orderId }) => Effect.log(`Warehouse notified: ${orderId}`),
  })
  .final(OrderState.Shipped)
  .final(OrderState.Cancelled);

// Run as actor (simple)
const program = Effect.gen(function* () {
  const actor = yield* Machine.spawn(orderMachine);

  yield* actor.send(OrderEvent.Process);
  yield* actor.send(OrderEvent.Ship({ trackingId: "TRACK-123" }));

  const state = yield* actor.snapshot;
  console.log(state); // Shipped { trackingId: "TRACK-123" }
});

Effect.runPromise(Effect.scoped(program));
```

## Core Concepts

### Schema-First

States and events ARE schemas. Single source of truth for types and serialization:

```ts
const MyState = State({
  Idle: {}, // Empty = plain value
  Loading: { url: Schema.String }, // Non-empty = constructor
});

MyState.Idle; // Value (no parens)
MyState.Loading({ url: "/api" }); // Constructor
```

### Guards and Effects as Slots

Define parameterized guards and effects, provide implementations:

```ts
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number },
});

const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
});

machine
  .on(MyState.Error, MyEvent.Retry, ({ state, guards }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        return MyState.Loading({ url: state.url }); // Transition first
      }
      return MyState.Failed;
    }),
  )
  // Fetch runs when entering Loading, auto-cancelled if state changes
  .spawn(MyState.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max,
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        const data = yield* Http.get(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
  });
```

### State-Scoped Effects

`.spawn()` runs effects when entering a state, auto-cancelled on exit:

```ts
machine
  .spawn(MyState.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  .spawn(MyState.Polling, ({ effects }) => effects.poll({ interval: "5 seconds" }));
```

`.task()` runs on entry and sends success/failure events:

```ts
machine.task(State.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }), {
  onSuccess: (data) => MyEvent.Resolve({ data }),
  onFailure: () => MyEvent.Reject,
});
```

### Testing

Test transitions without actors:

```ts
import { simulate, assertPath } from "effect-machine";

// Simulate events and check path
const result = yield * simulate(machine, [MyEvent.Start, MyEvent.Complete]);
expect(result.states.map((s) => s._tag)).toEqual(["Idle", "Loading", "Done"]);

// Assert specific path
yield * assertPath(machine, events, ["Idle", "Loading", "Done"]);
```

## Documentation

See the [primer](./primer/) for comprehensive documentation:

| Topic       | File                                      | Description                    |
| ----------- | ----------------------------------------- | ------------------------------ |
| Overview    | [index.md](./primer/index.md)             | Navigation and quick reference |
| Basics      | [basics.md](./primer/basics.md)           | Core concepts                  |
| Handlers    | [handlers.md](./primer/handlers.md)       | Transitions and guards         |
| Effects     | [effects.md](./primer/effects.md)         | spawn, background, timeouts    |
| Testing     | [testing.md](./primer/testing.md)         | simulate, harness, assertions  |
| Actors      | [actors.md](./primer/actors.md)           | ActorSystem, ActorRef          |
| Persistence | [persistence.md](./primer/persistence.md) | Snapshots, event sourcing      |
| Gotchas     | [gotchas.md](./primer/gotchas.md)         | Common mistakes                |

## API Quick Reference

### Building

| Method                                    | Purpose                      |
| ----------------------------------------- | ---------------------------- |
| `Machine.make({ state, event, initial })` | Create machine               |
| `.on(State.X, Event.Y, handler)`          | Add transition               |
| `.reenter(State.X, Event.Y, handler)`     | Force re-entry on same state |
| `.spawn(State.X, handler)`                | State-scoped effect          |
| `.task(State.X, run, { onSuccess })`      | State-scoped task            |
| `.background(handler)`                    | Machine-lifetime effect      |
| `.provide({ slot: impl })`                | Provide implementations      |
| `.final(State.X)`                         | Mark final state             |
| `.persist(config)`                        | Enable persistence           |

### Running

| Method                       | Purpose                                  |
| ---------------------------- | ---------------------------------------- |
| `Machine.spawn(machine)`     | Spawn actor (simple, no registry)        |
| `Machine.spawn(machine, id)` | Spawn actor with custom ID               |
| `system.spawn(id, machine)`  | Spawn via ActorSystem (registry/persist) |

### Testing

| Function                                   | Description                |
| ------------------------------------------ | -------------------------- |
| `simulate(machine, events)`                | Run events, get all states |
| `createTestHarness(machine)`               | Step-by-step testing       |
| `assertPath(machine, events, path)`        | Assert exact path          |
| `assertReaches(machine, events, tag)`      | Assert final state         |
| `assertNeverReaches(machine, events, tag)` | Assert state never visited |

### Actor

| Method                | Description       |
| --------------------- | ----------------- |
| `actor.send(event)`   | Queue event       |
| `actor.snapshot`      | Get current state |
| `actor.matches(tag)`  | Check state tag   |
| `actor.can(event)`    | Can handle event? |
| `actor.changes`       | Stream of changes |
| `actor.waitFor(fn)`   | Wait for match    |
| `actor.awaitFinal`    | Wait final state  |
| `actor.sendAndWait`   | Send + wait       |
| `actor.subscribe(fn)` | Sync callback     |

## License

MIT
