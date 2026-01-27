# Combinators

All machine builder combinators explained.

## Core

### on

Add a transition from state + event to new state.

```typescript
on(
  stateConstructor,  // e.g., State.Idle
  eventConstructor,  // e.g., Event.Fetch
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
on(State.Idle, Event.Start, ({ event }) => State.Running({ id: event.id }), {
  guard: ({ state }) => !state.locked,
  effect: ({ event }) => Effect.log(`Started ${event.id}`),
});
```

### final

Mark a state as terminal.

```typescript
final(stateConstructor);
```

**Example:**

```typescript
final(State.Success),
final(State.Error),
```

## State Effects

Effects use **named slots** - register the slot name, then provide handlers via `Machine.provide`.

### onEnter

Register entry effect slot.

```typescript
onEnter(stateConstructor, slotName);
```

**Example:**

```typescript
// Register slot
(Machine.onEnter(State.Success, "notifyUser"),
  // Provide handler
  Machine.provide(machine, {
    notifyUser: ({ state }) => Effect.log(`Success: ${state.data}`),
  }));
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
onExit(stateConstructor, slotName);
```

**Example:**

```typescript
// Register slot
(Machine.onExit(State.Editing, "saveDraft"),
  // Provide handler
  Machine.provide(machine, {
    saveDraft: ({ state }) => Effect.log(`Saved draft: ${state.content}`),
  }));
```

### invoke

Register invoke slot (runs on entry, auto-cancels on exit).

```typescript
invoke(stateConstructor, slotName);
```

Combines entry/exit with automatic fiber cancellation.

**Example:**

```typescript
// Register slot
(Machine.invoke(State.Polling, "poll"),
  // Provide handler
  Machine.provide(machine, {
    poll: ({ state, self }) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep("5 seconds");
          const data = yield* fetchStatus(state.id);
          yield* self.send(Event.StatusUpdate({ data }));
        }
      }),
  }));
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
const liveMachine = Machine.make<State, Event>(State.Idle()).pipe(
  Machine.on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
  Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
  Machine.invoke(State.Loading, "fetchData"),
  Machine.onEnter(State.Success, "notify"),
  Machine.provide({
    fetchData: ({ state, self }) =>
      Effect.gen(function* () {
        const data = yield* httpClient.get(state.url);
        yield* self.send(Event.Resolve({ data }));
      }),
    notify: ({ state }) => Effect.log(`Done: ${state.data}`),
  }),
);

// Or split for different implementations
const baseMachine = Machine.make<State, Event>(State.Idle()).pipe(
  Machine.on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
  Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
  Machine.invoke(State.Loading, "fetchData"),
  Machine.onEnter(State.Success, "notify"),
);

// Production handlers
const liveMachine = Machine.provide(baseMachine, {
  fetchData: ({ state, self }) =>
    Effect.gen(function* () {
      const data = yield* httpClient.get(state.url);
      yield* self.send(Event.Resolve({ data }));
    }),
  notify: ({ state }) => Effect.log(`Done: ${state.data}`),
});

// Test handlers (mocked)
const testMachine = Machine.provide(baseMachine, {
  fetchData: ({ self }) => self.send(Event.Resolve({ data: "mock" })),
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
choose(stateConstructor, eventConstructor, [
  { guard: (ctx) => boolean, to: (ctx) => newState },
  { guard: (ctx) => boolean, to: (ctx) => newState },
  { otherwise: true, to: (ctx) => newState },
]);
```

**Example:**

```typescript
choose(State.Form, Event.Submit, [
  {
    guard: ({ state }) => !state.email,
    to: () => State.Error({ field: "email" }),
  },
  {
    guard: ({ state }) => !state.password,
    to: () => State.Error({ field: "password" }),
  },
  {
    otherwise: true,
    to: ({ state }) => State.Submitting({ data: state }),
  },
]);
```

Evaluated top-to-bottom. First match wins.

### always

Eventless transitions - fire immediately when state matches.

```typescript
always(stateConstructor, [
  { guard: (state) => boolean, to: (state) => newState },
  { otherwise: true, to: (state) => newState },
]);
```

**Note:** `always` handlers receive just the state, not a context object.

**Example:**

```typescript
always(State.Calculating, [
  { guard: (s) => s.value >= 100, to: () => State.Overflow() },
  { guard: (s) => s.value >= 70, to: (s) => State.High(s) },
  { guard: (s) => s.value >= 40, to: (s) => State.Medium(s) },
  { otherwise: true, to: (s) => State.Low(s) },
]);
```

**Cascading:** Always transitions can trigger other always transitions:

```typescript
always(State.A, [{ otherwise: true, to: () => State.B() }]),
always(State.B, [{ otherwise: true, to: () => State.C() }]),
always(State.C, [{ otherwise: true, to: () => State.Done() }]),
// A → B → C → Done happens in one step
```

Max 100 iterations to prevent infinite loops.

## Delayed Events

### delay

Schedule event after duration.

```typescript
delay(
  stateConstructor,
  duration,   // DurationInput: "3 seconds", 3000, etc.
  event,      // Event to send
  options?,   // { guard?: (state) => boolean }
)
```

**Example:**

```typescript
delay(State.Success, "3 seconds", Event.Dismiss()),

// With guard
delay(State.Error, "5 seconds", Event.Retry(), {
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
assign(updater); // (ctx) => Partial<State>
```

**Example:**

```typescript
on(State.Form, Event.SetName, assign(({ event }) => ({ name: event.name }))),
on(State.Form, Event.SetEmail, assign(({ event }) => ({ email: event.email }))),
```

### update

Shorthand for `on` + `assign`.

```typescript
update(
  stateConstructor,
  eventConstructor,
  updater,   // (ctx) => Partial<State>
  options?,  // { guard?, effect? }
)
```

**Example:**

```typescript
// These are equivalent:
on(
  State.Form,
  Event.SetName,
  assign(({ event }) => ({ name: event.name })),
);
update(State.Form, Event.SetName, ({ event }) => ({ name: event.name }));
```

## See Also

- `guards.md` - guard composition in depth
- `basics.md` - core concepts
- `testing.md` - testing patterns
