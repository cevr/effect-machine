# Basics

Core concepts for building state machines with effect-machine.

## State Schema

States are defined with `State()`. Each variant is a schema:

```ts
import { Schema } from "effect";
import { State } from "effect-machine";

const MyState = State({
  Idle: {}, // Empty - plain value
  Loading: { url: Schema.String }, // Non-empty - constructor
  Success: { data: Schema.Unknown },
  Error: { message: Schema.String, code: Schema.Number },
});

type MyState = typeof MyState.Type; // Extract type

// Usage
MyState.Idle; // Value (no parens)
MyState.Loading({ url: "/api" }); // Constructor (args required)
MyState.Error({ message: "fail", code: 500 });
```

**Key insight**: States ARE schemas. This enables automatic serialization for persistence and clustering.

## Event Schema

Events follow the same pattern:

```ts
const MyEvent = Event({
  Start: {},
  Fetch: { url: Schema.String },
  Resolve: { data: Schema.Unknown },
  Reject: { error: Schema.String },
});

type MyEvent = typeof MyEvent.Type;

// Usage
MyEvent.Start; // Value
MyEvent.Fetch({ url: "/api" }); // Constructor
```

## Machine Builder

Create machines with `Machine.make()`:

```ts
import { Machine } from "effect-machine";

const machine = Machine.make({
  state: MyState, // Required
  event: MyEvent, // Required
  initial: MyState.Idle, // Required
  guards: MyGuards, // Optional - Slot.Guards
  effects: MyEffects, // Optional - Slot.Effects
});
```

Types are inferred from schemas - no manual type parameters needed.

## Transitions with `.on()`

Define transitions with `.on(state, event, handler)`:

```ts
machine
  .on(MyState.Idle, MyEvent.Start, () => MyState.Loading({ url: "/default" }))
  .on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
  .on(MyState.Loading, MyEvent.Reject, ({ event }) =>
    MyState.Error({ message: event.error, code: 500 }),
  );
```

Handler receives `{ state, event, guards, effects }` and returns new state or `Effect<State>`.

## Final States

Mark states as final with `.final()`:

```ts
machine.final(MyState.Success).final(MyState.Error);
```

Actor stops when reaching a final state.

## Pattern Matching

States and events have `$is()` and `$match()` helpers:

```ts
// Type guard
if (MyState.$is("Loading")(state)) {
  console.log(state.url); // TypeScript knows this is Loading
}

// Pattern matching
const message = MyState.$match(state, {
  Idle: () => "Waiting...",
  Loading: ({ url }) => `Fetching ${url}`,
  Success: ({ data }) => `Got: ${data}`,
  Error: ({ message }) => `Error: ${message}`,
});
```

## Slots: Guards and Effects

Guards and effects are defined as parameterized slots:

```ts
import { Slot } from "effect-machine";

// Guard slots - return boolean
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number }, // With params
  isValid: {}, // No params
});

// Effect slots - return Effect<void>
const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
  notify: {},
});
```

Use in machine:

```ts
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards,
  effects: MyEffects,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, ({ guards, effects }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        yield* effects.notify();
        return MyState.Loading({ url: "/api" });
      }
      return MyState.Error({ message: "Max retries", code: 429 });
    }),
  )
  .provide({
    canRetry: ({ max }, { state }) => {
      // state.attempts < max
      return true;
    },
    notify: (_, { self }) => Effect.log("Starting..."),
  });
```

**Key pattern**: Guards/effects called inside handler with `yield*`. Implementations in `.provide()`.

## Provide Signature

`.provide()` maps slot names to implementations:

```ts
.provide({
  slotName: (params, ctx) => result,
})
```

| Argument | Type                     | Description                                |
| -------- | ------------------------ | ------------------------------------------ |
| `params` | Schema type              | Parameters defined in slot                 |
| `ctx`    | `{ state, event, self }` | Current state, triggering event, actor ref |

**Guards** return `boolean | Effect<boolean>`.
**Effects** return `Effect<void>`.

## Reusable Machines

`.provide()` creates a new machine instance:

```ts
const baseMachine = Machine.make({...})
  .on(...)
  .spawn(...);

// Different implementations for different contexts
const devMachine = baseMachine.provide({ fetch: mockFetch });
const prodMachine = baseMachine.provide({ fetch: realFetch });
```

Original machine unchanged - safe to reuse.

## See Also

- `handlers.md` - Advanced handler patterns
- `effects.md` - spawn and background effects
- `testing.md` - Testing machines
