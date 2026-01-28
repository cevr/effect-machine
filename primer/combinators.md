# Combinators

All machine builder combinators explained.

## Core

### on

Add a transition from state + event to new state.

```typescript
machine.on(
  stateConstructor, // e.g., MyState.Idle
  eventConstructor, // e.g., MyEvent.Fetch
  handler, // (ctx) => State | Effect<State>
);
```

**Handler context:**

```typescript
type HandlerContext<S, E, GD, EFD> = {
  state: S;      // Current state (narrowed)
  event: E;      // Triggering event (narrowed)
  guards: {...}; // Guard accessors (if guards defined)
  effects: {...}; // Effect accessors (if effects defined)
};
```

**Example:**

```typescript
machine.on(MyState.Idle, MyEvent.Start, ({ event }) => MyState.Running({ id: event.id }));

// With guards
machine.on(MyState.Form, MyEvent.Submit, ({ state, guards }) =>
  Effect.gen(function* () {
    if (yield* guards.isValid()) {
      return MyState.Submitting;
    }
    return state;
  }),
);
```

### on.force

Like `on` but forces exit/enter effects even for same state tag.

```typescript
machine.on.force(MyState.Active, MyEvent.Refresh, ({ state }) =>
  MyState.Active({ ...state, lastRefresh: Date.now() }),
);
```

Useful for restarting delay timers or re-running invoke effects.

### final

Mark a state as terminal.

```typescript
machine.final(stateConstructor);
```

**Example:**

```typescript
machine.final(MyState.Success).final(MyState.Error);
```

## State Effects

### onEnter

Run effect when entering state.

```typescript
machine.onEnter(stateConstructor, handler);
```

**Example:**

```typescript
machine.onEnter(MyState.Success, ({ state }) => Effect.log(`Success: ${state.data}`));

// With effects slot
machine.onEnter(MyState.Active, ({ state, effects }) =>
  effects.notify({ message: `User ${state.userId} is active` }),
);
```

### onExit

Run effect when exiting state.

```typescript
machine.onExit(stateConstructor, handler);
```

**Example:**

```typescript
machine.onExit(MyState.Editing, ({ state }) => Effect.log(`Saved draft: ${state.content}`));
```

### invoke

Run effect on entry, auto-cancel on exit. For long-running processes.

```typescript
machine.invoke(stateConstructor, slotName);
machine.invoke(stateConstructor, [slot1, slot2]); // parallel
machine.invoke(slotName); // root-level (machine lifetime)
```

**Example:**

```typescript
const machine = Machine.make({ state, event, initial })
  .invoke(MyState.Polling, "poll")
  .provide({
    poll: ({ state, self }) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds");
          const data = yield* fetchStatus(state.id);
          yield* self.send(MyEvent.StatusUpdate({ data }));
        }
      }),
  });
```

The polling fiber is interrupted when exiting `Polling` state.

### provide

Wire handlers to guard/effect slots. Required before spawning.

```typescript
machine.provide({
  guardName: (params, ctx) => boolean | Effect<boolean>,
  effectName: (params, ctx) => Effect<void>,
  invokeName: (ctx) => Effect<void>,
});
```

**Context structure:**

```typescript
type SlotContext<S, E> = {
  state: S;
  event: E;
  self: MachineRef<E>;
};
```

**Example:**

```typescript
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number },
});

const MyEffects = Slot.Effects({
  notify: { message: Schema.String },
});

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards,
  effects: MyEffects,
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
  .invoke(MyState.Loading, "fetchData")
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max,
    notify: ({ message }) => Effect.log(message),
    fetchData: ({ state, self }) =>
      Effect.gen(function* () {
        const data = yield* httpClient.get(state.url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
  });
```

**Notes:**

- All slots must have handlers - missing keys → runtime error
- `simulate()` works without `provide()` (invoke effects skipped)
- `provide()` returns new machine - original reusable with different handlers

## Eventless Transitions

### always

Eventless transitions - fire immediately when state matches.

```typescript
machine.always(stateConstructor, handler);
```

**Handler receives state and optional guards:**

```typescript
// Without guards
machine.always(MyState.Calculating, (state) => {
  if (state.value >= 100) return MyState.Overflow;
  if (state.value >= 70) return MyState.High({ value: state.value });
  return MyState.Low({ value: state.value });
});

// With guards
machine.always(MyState.Pending, (state, guards) =>
  Effect.gen(function* () {
    if (yield* guards.shouldAutoApprove()) {
      return MyState.Approved;
    }
    return state; // stay in Pending
  }),
);
```

**Cascading:** Always transitions can trigger other always transitions:

```typescript
machine
  .always(MyState.A, () => MyState.B)
  .always(MyState.B, () => MyState.C)
  .always(MyState.C, () => MyState.Done);
// A → B → C → Done happens in one step
```

Max 100 iterations to prevent infinite loops.

## Delayed Events

### delay

Schedule event after duration.

```typescript
machine.delay(
  stateConstructor,
  duration, // DurationInput: "3 seconds", 3000, etc.
  event, // Event to send
);
```

**Example:**

```typescript
machine.delay(MyState.Success, "3 seconds", MyEvent.Dismiss);

// Dynamic duration based on state
machine.delay(MyState.Retrying, (state) => `${state.attempts * 2} seconds`, MyEvent.Retry);
```

Timer is cancelled if:

- State exits before duration
- Actor is stopped

Works with TestClock for deterministic testing.

## Scoped Builders

### from

Scope multiple transitions to a single state.

```typescript
machine.from(stateConstructor, (scope) => scope.on(Event1, handler1).on(Event2, handler2));
```

**Example:**

```typescript
machine.from(MyState.Form, (scope) =>
  scope
    .on(MyEvent.SetName, ({ state, event }) => MyState.Form({ ...state, name: event.name }))
    .on(MyEvent.SetEmail, ({ state, event }) => MyState.Form({ ...state, email: event.email }))
    .on(MyEvent.Submit, ({ state, guards }) =>
      Effect.gen(function* () {
        if (yield* guards.isValid()) {
          return MyState.Submitting({ data: state });
        }
        return state;
      }),
    ),
);
```

### onAny

Same transition for multiple states.

```typescript
machine.onAny([State1, State2, State3], eventConstructor, handler);
```

**Example:**

```typescript
machine.onAny(
  [MyState.Loading, MyState.Retrying, MyState.Processing],
  MyEvent.Cancel,
  () => MyState.Cancelled,
);
```

## State Updates

### assign

Helper for partial state updates (doesn't change tag).

```typescript
import { assign } from "effect-machine";

machine.on(
  MyState.Form,
  MyEvent.SetName,
  assign(({ event }) => ({ name: event.name })),
);
```

## See Also

- `guards.md` - parameterized guards in depth
- `basics.md` - core concepts
- `testing.md` - testing patterns
