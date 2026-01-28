# Basics

Core concepts for building state machines with effect-machine.

## States and Events

States and events are schema-first definitions:

```typescript
import { Schema } from "effect";
import { State, Event } from "effect-machine";

// States - what the machine can be (schema-first)
const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Success: { data: Schema.String },
  Error: { message: Schema.String },
});
type MyState = typeof MyState.Type;

// Events - what can happen (schema-first)
const MyEvent = Event({
  Fetch: { url: Schema.String },
  Resolve: { data: Schema.String },
  Reject: { message: Schema.String },
});
type MyEvent = typeof MyEvent.Type;
```

**Why schema-first?**

- Single source of truth for types AND serialization
- Exhaustive pattern matching
- Type narrowing in handlers
- Structural equality for testing
- Compile-time prevention of state/event mixups
- Automatic persistence support (schemas attached to machine)

## Building Machines

Use `Machine.make({ state, event, initial })` to compose a machine definition:

```typescript
import { Effect, Schema } from "effect";
import { Machine, State, Event } from "effect-machine";

// Define state and event schemas
const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Success: { data: Schema.String },
  Error: { message: Schema.String },
});
type MyState = typeof MyState.Type;

const MyEvent = Event({
  Fetch: { url: Schema.String },
  Resolve: { data: Schema.String },
  Reject: { message: Schema.String },
});
type MyEvent = typeof MyEvent.Type;

// Machine.make infers types from schemas - no manual type params needed!
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  // Transitions: from state + event → new state
  .on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url }))
  .on(MyState.Loading, MyEvent.Resolve, ({ event }) => MyState.Success({ data: event.data }))
  .on(MyState.Loading, MyEvent.Reject, ({ event }) => MyState.Error({ message: event.message }))

  // Final states (no transitions out)
  .final(MyState.Success)
  .final(MyState.Error);
```

## Transition Handlers

Handlers receive a context object with `state` and `event`:

```typescript
machine.on(MyState.Loading, MyEvent.Resolve, ({ state, event }) => {
  // state is narrowed to Loading
  // event is narrowed to Resolve
  return MyState.Success({ data: event.data });
});
```

### Returning Effects

Handlers can return an Effect for async transitions:

```typescript
machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) =>
  Effect.gen(function* () {
    const data = yield* fetchData(event.url);
    return MyState.Success({ data });
  }),
);
```

## Guards

Conditionally enable transitions using guard slots:

```typescript
const MyGuards = Slot.Guards({
  isValid: {},
});

Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards,
  initial: MyState.Form({ isValid: false }),
})
  .on(MyState.Form, MyEvent.Submit, ({ state, guards }) =>
    Effect.gen(function* () {
      if (yield* guards.isValid()) {
        return MyState.Submitting;
      }
      return state;
    }),
  )
  .provide({
    isValid: (_params, { state }) => state.email.includes("@"),
  });
```

If guard returns `false`, stay in current state.

## State Effects with spawn

Run effects when entering a state. Spawn handlers call effect slots defined via `Slot.Effects`:

```typescript
import { Machine, State, Event, Slot } from "effect-machine";

const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
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
  .provide({
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
        const data = yield* fetchData(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
  });
```

`self.send` lets you send events back to the machine from effects.

## Delayed Events

Schedule events after a duration using spawn. Timer is automatically cancelled when state exits.

```typescript
const MyEffects = Slot.Effects({
  scheduleAutoDismiss: {},
});

Machine.make({
  state: MyState,
  event: MyEvent,
  effects: MyEffects,
  initial: MyState.Success({ message: "Done" }),
})
  .on(MyState.Success, MyEvent.Dismiss, () => MyState.Dismissed)
  .spawn(MyState.Success, ({ effects }) => effects.scheduleAutoDismiss())
  .provide({
    scheduleAutoDismiss: (_, { self }) =>
      Effect.sleep("3 seconds").pipe(Effect.andThen(self.send(MyEvent.Dismiss))),
  });
```

Use `reenter` to reset the timer on activity (timer restarts when spawn effects re-run).

## Final States

Mark states as terminal:

```typescript
machine.final(MyState.Success).final(MyState.Error);
```

Once in a final state:

- No transitions are processed
- Actor stops automatically

## See Also

- `combinators.md` - all combinators in detail
- `guards.md` - guard composition
- `testing.md` - testing your machines
