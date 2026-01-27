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

Use `Machine.make({ state, event, initial }).pipe()` to compose a machine definition:

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
  initial: MyState.Idle(),
}).pipe(
  // Transitions: from state + event → new state
  Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  Machine.on(MyState.Loading, MyEvent.Resolve, ({ event }) =>
    MyState.Success({ data: event.data }),
  ),
  Machine.on(MyState.Loading, MyEvent.Reject, ({ event }) =>
    MyState.Error({ message: event.message }),
  ),

  // Final states (no transitions out)
  Machine.final(MyState.Success),
  Machine.final(MyState.Error),
);
```

## Transition Handlers

Handlers receive a context object with `state` and `event`:

```typescript
Machine.on(MyState.Loading, MyEvent.Resolve, ({ state, event }) => {
  // state is narrowed to Loading
  // event is narrowed to Resolve
  return MyState.Success({ data: event.data });
});
```

### Returning Effects

Handlers can return an Effect for async transitions:

```typescript
Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) =>
  Effect.gen(function* () {
    const data = yield* fetchData(event.url);
    return MyState.Success({ data });
  }),
);
```

## Guards

Conditionally enable transitions:

```typescript
Machine.on(MyState.Form, MyEvent.Submit, ({ state }) => MyState.Submitting(), {
  guard: ({ state }) => state.isValid,
});
```

If guard returns `false`, the transition is skipped and state remains unchanged.

## Effects

Run side effects on transitions:

```typescript
Machine.on(MyState.Idle, MyEvent.Start, () => MyState.Running(), {
  effect: ({ state, event }) => Effect.log(`Starting from ${state._tag} with ${event._tag}`),
});
```

Effects run after the state change is committed.

## Final States

Mark states as terminal:

```typescript
Machine.final(MyState.Success),
Machine.final(MyState.Error),
```

Once in a final state:

- No transitions are processed
- Actor stops automatically

## State Entry/Exit (Effect Slots)

Register effect slots for state entry/exit, then provide handlers:

```typescript
import { Machine, State, Event } from "effect-machine";

const baseMachine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle(),
}).pipe(
  Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  Machine.on(MyState.Loading, MyEvent.Resolve, ({ event }) =>
    MyState.Success({ data: event.data }),
  ),
  // Register effect slots
  Machine.onEnter(MyState.Loading, "startLoading"),
  Machine.onExit(MyState.Loading, "cleanupLoading"),
);

// Provide handlers
const machine = Machine.provide(baseMachine, {
  startLoading: ({ state, self }) =>
    Effect.gen(function* () {
      const data = yield* fetchData(state.url);
      yield* self.send(MyEvent.Resolve({ data }));
    }),
  cleanupLoading: () => Effect.log("Leaving Loading"),
});
```

`self.send` lets you send events back to the machine from effects.

## Eventless Transitions (always)

Transitions that fire immediately based on state:

```typescript
Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Calculating({ value: 75 }),
}).pipe(
  Machine.always(MyState.Calculating, [
    { guard: (s) => s.value >= 70, to: (s) => MyState.High({ value: s.value }) },
    { guard: (s) => s.value >= 40, to: (s) => MyState.Medium({ value: s.value }) },
    { to: (s) => MyState.Low({ value: s.value }) }, // Fallback (no guard)
  ]),
);
```

Branches are evaluated top-to-bottom. First match wins.

## Delayed Events

Auto-send events after a duration:

```typescript
Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Success({ message: "Done" }),
}).pipe(
  Machine.on(MyState.Success, MyEvent.Dismiss, () => MyState.Dismissed()),
  Machine.delay(MyState.Success, "3 seconds", MyEvent.Dismiss()),
);
```

Timer is cancelled if state exits before duration.

## See Also

- `combinators.md` - all combinators in detail
- `guards.md` - guard composition
- `testing.md` - testing your machines
