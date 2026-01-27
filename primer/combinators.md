# Combinators

All machine builder combinators explained.

## Core

### on

Add a transition from state + event to new state.

```typescript
Machine.on(
  stateConstructor,  // e.g., MyState.Idle
  eventConstructor,  // e.g., MyEvent.Fetch
  handler,           // (ctx) => newState
  options?,          // { guard?, effect? }
)
```

**Handler context:**

```typescript
type TransitionContext<S, E> = {
  state: S; // Current state (narrowed)
  event: E; // Triggering event (narrowed)
};
```

**Options:**

```typescript
{
  guard?: (ctx) => boolean,        // Enable/disable transition
  effect?: (ctx) => Effect<void>,  // Side effect after transition
}
```

**Example:**

```typescript
Machine.on(MyState.Idle, MyEvent.Start, ({ event }) => MyState.Running({ id: event.id }), {
  guard: ({ state }) => !state.locked,
  effect: ({ event }) => Effect.log(`Started ${event.id}`),
});
```

### final

Mark a state as terminal.

```typescript
Machine.final(stateConstructor);
```

**Example:**

```typescript
Machine.final(MyState.Success),
Machine.final(MyState.Error),
```

## State Effects

Effects use **named slots** - register the slot name, then provide handlers via `Machine.provide`.

### onEnter

Register entry effect slot.

```typescript
Machine.onEnter(stateConstructor, slotName);
```

**Example:**

```typescript
// Register slot in machine definition
const baseMachine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.Start, () => MyState.Success({ data: "done" })),
  Machine.onEnter(MyState.Success, "notifyUser"),
);

// Provide handler
const machine = Machine.provide(baseMachine, {
  notifyUser: ({ state }) => Effect.log(`Success: ${state.data}`),
});
```

**Handler context:**

```typescript
type StateEffectContext<S, E> = {
  state: S; // Current state
  self: { send: (e: E) => Effect<void> }; // Self-reference
};
```

### onExit

Register exit effect slot.

```typescript
Machine.onExit(stateConstructor, slotName);
```

**Example:**

```typescript
// Register slot
const baseMachine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.Edit, () => MyState.Editing({ content: "" })),
  Machine.on(MyState.Editing, MyEvent.Save, () => MyState.Saved()),
  Machine.onExit(MyState.Editing, "saveDraft"),
);

// Provide handler
const machine = Machine.provide(baseMachine, {
  saveDraft: ({ state }) => Effect.log(`Saved draft: ${state.content}`),
});
```

### invoke

Register invoke slot (runs on entry, auto-cancels on exit).

```typescript
Machine.invoke(stateConstructor, slotName);
```

Combines entry/exit with automatic fiber cancellation.

**Example:**

```typescript
// Register slot
const baseMachine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.StartPolling, ({ event }) => MyState.Polling({ id: event.id })),
  Machine.on(MyState.Polling, MyEvent.Stop, () => MyState.Idle()),
  Machine.invoke(MyState.Polling, "poll"),
);

// Provide handler
const machine = Machine.provide(baseMachine, {
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

Wire handlers to all effect slots. Required before spawning.

```typescript
// Data-last (pipeable)
Machine.provide({
  slotName: (ctx) => Effect<void>,
  ...
})

// Data-first
Machine.provide(machine, {
  slotName: (ctx) => Effect<void>,
  ...
})
```

**Example:**

```typescript
// Pipeable form - all in one pipe
const liveMachine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  Machine.on(MyState.Loading, MyEvent.Resolve, ({ event }) =>
    MyState.Success({ data: event.data }),
  ),
  Machine.invoke(MyState.Loading, "fetchData"),
  Machine.onEnter(MyState.Success, "notify"),
  Machine.provide({
    fetchData: ({ state, self }) =>
      Effect.gen(function* () {
        const data = yield* httpClient.get(state.url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
    notify: ({ state }) => Effect.log(`Done: ${state.data}`),
  }),
);

// Or split for different implementations
const baseMachine = Machine.make<MyState, MyEvent>(MyState.Idle()).pipe(
  Machine.on(MyState.Idle, MyEvent.Fetch, ({ event }) => MyState.Loading({ url: event.url })),
  Machine.on(MyState.Loading, MyEvent.Resolve, ({ event }) =>
    MyState.Success({ data: event.data }),
  ),
  Machine.invoke(MyState.Loading, "fetchData"),
  Machine.onEnter(MyState.Success, "notify"),
);

// Production handlers
const liveMachine = Machine.provide(baseMachine, {
  fetchData: ({ state, self }) =>
    Effect.gen(function* () {
      const data = yield* httpClient.get(state.url);
      yield* self.send(MyEvent.Resolve({ data }));
    }),
  notify: ({ state }) => Effect.log(`Done: ${state.data}`),
});

// Test handlers (mocked)
const testMachine = Machine.provide(baseMachine, {
  fetchData: ({ self }) => self.send(MyEvent.Resolve({ data: "mock" })),
  notify: () => Effect.void,
});
```

**Notes:**

- All slots must have handlers - missing keys → runtime error
- Extra keys → runtime error
- `simulate()` works without `provide()` (effects skipped)

## Guard Cascade

### choose

Multiple guarded transitions for same state + event.

```typescript
Machine.choose(stateConstructor, eventConstructor, [
  { guard: (ctx) => boolean, to: (ctx) => newState },
  { guard: (ctx) => boolean, to: (ctx) => newState },
  { to: (ctx) => newState }, // Fallback (no guard)
]);
```

**Example:**

```typescript
Machine.choose(MyState.Form, MyEvent.Submit, [
  {
    guard: ({ state }) => !state.email,
    to: () => MyState.Error({ field: "email" }),
  },
  {
    guard: ({ state }) => !state.password,
    to: () => MyState.Error({ field: "password" }),
  },
  {
    to: ({ state }) => MyState.Submitting({ data: state }), // Fallback
  },
]);
```

Evaluated top-to-bottom. First match wins.

### always

Eventless transitions - fire immediately when state matches.

```typescript
Machine.always(stateConstructor, [
  { guard: (state) => boolean, to: (state) => newState },
  { to: (state) => newState }, // Fallback (no guard)
]);
```

**Note:** `always` handlers receive just the state, not a context object.

**Example:**

```typescript
Machine.always(MyState.Calculating, [
  { guard: (s) => s.value >= 100, to: () => MyState.Overflow() },
  { guard: (s) => s.value >= 70, to: (s) => MyState.High(s) },
  { guard: (s) => s.value >= 40, to: (s) => MyState.Medium(s) },
  { to: (s) => MyState.Low(s) }, // Fallback
]);
```

**Cascading:** Always transitions can trigger other always transitions:

```typescript
Machine.always(MyState.A, [{ to: () => MyState.B() }]),
Machine.always(MyState.B, [{ to: () => MyState.C() }]),
Machine.always(MyState.C, [{ to: () => MyState.Done() }]),
// A → B → C → Done happens in one step
```

Max 100 iterations to prevent infinite loops.

## Delayed Events

### delay

Schedule event after duration.

```typescript
Machine.delay(
  stateConstructor,
  duration,   // DurationInput: "3 seconds", 3000, etc.
  event,      // Event to send
  options?,   // { guard?: (state) => boolean }
)
```

**Example:**

```typescript
Machine.delay(MyState.Success, "3 seconds", MyEvent.Dismiss()),

// With guard
Machine.delay(MyState.Error, "5 seconds", MyEvent.Retry(), {
  guard: (state) => state.canRetry,
}),
```

Timer is cancelled if:

- State exits before duration
- Actor is stopped

Works with TestClock for deterministic testing.

## State Updates

### assign

Helper for partial state updates (doesn't change tag).

```typescript
Machine.assign(updater); // (ctx) => Partial<State>
```

**Example:**

```typescript
Machine.on(MyState.Form, MyEvent.SetName, Machine.assign(({ event }) => ({ name: event.name }))),
Machine.on(MyState.Form, MyEvent.SetEmail, Machine.assign(({ event }) => ({ email: event.email }))),
```

### update

Shorthand for `on` + `assign`.

```typescript
Machine.update(
  stateConstructor,
  eventConstructor,
  updater,   // (ctx) => Partial<State>
  options?,  // { guard?, effect? }
)
```

**Example:**

```typescript
// These are equivalent:
Machine.on(
  MyState.Form,
  MyEvent.SetName,
  Machine.assign(({ event }) => ({ name: event.name })),
);
Machine.update(MyState.Form, MyEvent.SetName, ({ event }) => ({ name: event.name }));
```

## See Also

- `guards.md` - guard composition in depth
- `basics.md` - core concepts
- `testing.md` - testing patterns
