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

### reenter

Like `on` but forces exit/enter effects even for same state tag.

```typescript
machine.reenter(MyState.Active, MyEvent.Refresh, ({ state }) =>
  MyState.Active({ ...state, lastRefresh: Date.now() }),
);
```

Useful for restarting spawn timers or re-running spawn effects.

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

### spawn

Run effect on state entry, auto-cancel on exit. Spawn handlers call effect slots.

```typescript
machine.spawn(stateConstructor, handler);
```

**Example:**

```typescript
const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
});

machine
  .spawn(MyState.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  .provide({
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
        const data = yield* httpClient.get(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
  });
```

The effect is forked into a state-scoped scope. When the state exits, the fiber is interrupted and finalizers run.

### Timeout Pattern with spawn

Schedule an event after a duration using spawn. The timer is automatically cancelled when exiting the state.

```typescript
const MyEffects = Slot.Effects({
  scheduleTimeout: {},
});

machine
  .spawn(MyState.Active, ({ effects }) => effects.scheduleTimeout())
  .provide({
    scheduleTimeout: (_, { self }) =>
      Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(MyEvent.Timeout))),
  });
```

**Dynamic duration based on state:**

```typescript
.provide({
  scheduleTimeout: (_, { self, state }) => {
    const s = state as MyState & { _tag: "Active" };
    return Effect.sleep(Duration.seconds(s.retryCount * 2)).pipe(
      Effect.andThen(self.send(MyEvent.Timeout))
    );
  },
})
```

**Reset timer with reenter:**

```typescript
// Timer restarts because reenter runs exit/enter effects
machine
  .spawn(MyState.Active, ({ effects }) => effects.scheduleTimeout())
  .reenter(MyState.Active, MyEvent.Activity, ({ state }) =>
    MyState.Active({ ...state, lastActivity: Date.now() }),
  );
```

### background

Run effect for machine lifetime (not tied to state). Background handlers call effect slots.

```typescript
machine.background(handler);
```

**Example:**

```typescript
const MyEffects = Slot.Effects({
  heartbeat: {},
});

machine
  .background(({ effects }) => effects.heartbeat())
  .provide({
    heartbeat: (_, { self }) =>
      Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(MyEvent.Ping)))),
  });
```

Background effects start on actor spawn and are interrupted when the actor stops.

### provide

Wire handlers to guard/effect slots. Required before spawning.

```typescript
machine.provide({
  guardName: (params, ctx) => boolean | Effect<boolean>,
  effectName: (params, ctx) => Effect<void>,
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
  fetchData: { url: Schema.String },
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
  // Spawn/background call effect slots
  .spawn(MyState.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max,
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        const data = yield* httpClient.get(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
    notify: ({ message }) => Effect.log(message),
  });
```

**Notes:**

- All guard/effect slots must have handlers - missing keys → runtime error
- `simulate()` works without `provide()` (spawn effects skipped)
- `provide()` returns new machine - original reusable with different handlers

## Guard Cascade

### choose

Event-triggered guard cascade.

```typescript
machine.choose(stateConstructor, eventConstructor, branches);
```

**Branches evaluated top-to-bottom, first match wins:**

```typescript
machine.choose(MyState.Input, MyEvent.Classify, [
  { guard: ({ state }) => state.value >= 70, to: () => MyState.High },
  { guard: ({ state }) => state.value >= 40, to: () => MyState.Medium },
  { to: () => MyState.Low }, // Fallback (no guard)
]);
```

## See Also

- `guards.md` - parameterized guards in depth
- `basics.md` - core concepts
- `testing.md` - testing patterns
