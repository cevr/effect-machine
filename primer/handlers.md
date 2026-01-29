# Transition Handlers

Writing transition handlers, guards, and conditional logic.

## Handler Context

Handlers receive a context object:

```ts
.on(State.X, Event.Y, ({ state, event, guards, effects }) => {
  // state: current state (typed to State.X)
  // event: triggering event (typed to Event.Y)
  // guards: slot accessors for guards
  // effects: slot accessors for effects
  return newState;
})
```

## Handler Type Constraints

Handlers are strictly typed at compile time:

| Constraint             | Enforced | Notes                                |
| ---------------------- | -------- | ------------------------------------ |
| Requirements = `never` | ✓        | No arbitrary services in handlers    |
| Errors = `never`       | ✓        | Handlers cannot fail                 |
| Return state ∈ schema  | ✓        | Must return machine's state variants |

**Services must go through slots** - define with `Slot.Effects`, implement with `.provide()`:

```ts
// ✗ BAD - won't compile (MyService not in R=never)
.on(State.X, Event.Y, () =>
  Effect.gen(function* () {
    yield* MyService;  // Error: Type 'MyService' not assignable to 'never'
    return State.Z;
  })
)

// ✓ GOOD - use effect slots
.on(State.X, Event.Y, ({ effects }) => effects.doSomething())
.provide({
  doSomething: (_, { self }) => MyService.pipe(Effect.flatMap(...))
})
```

## Sync vs Async Handlers

**Sync** - return state directly:

```ts
.on(State.Idle, Event.Start, ({ event }) =>
  State.Loading({ url: event.url })
)
```

**Async** - return `Effect<State>`:

```ts
.on(State.Loading, Event.Fetch, ({ state, effects }) =>
  Effect.gen(function* () {
    yield* effects.logStart();
    // ... async logic
    return State.Success({ data: "result" });
  })
)
```

## Guards in Handlers

Guards are checked inside handlers with `yield*`:

```ts
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number },
  hasPermission: { role: Schema.String },
});

.on(State.Error, Event.Retry, ({ state, guards }) =>
  Effect.gen(function* () {
    // Check guard with params
    if (yield* guards.canRetry({ max: 3 })) {
      return State.Loading({ url: state.url });
    }
    return State.Failed;
  })
)
.provide({
  canRetry: ({ max }, { state }) => state.attempts < max,
  hasPermission: ({ role }, { state }) => state.userRole === role,
})
```

**Sync guards** return `boolean`:

```ts
canRetry: ({ max }, { state }) => state.attempts < max;
```

**Async guards** return `Effect<boolean>`:

```ts
hasPermission: ({ role }, { self }) =>
  Effect.gen(function* () {
    const permissions = yield* fetchPermissions();
    return permissions.includes(role);
  });
```

## Calling Effects in Handlers

Effects are side effects that run during transition:

```ts
.on(State.Idle, Event.Start, ({ state, effects }) =>
  Effect.gen(function* () {
    yield* effects.logTransition({ from: "Idle", to: "Loading" });
    yield* effects.trackAnalytics({ event: "start" });
    return State.Loading({ url: "/api" });
  })
)
.provide({
  logTransition: ({ from, to }) =>
    Effect.log(`${from} -> ${to}`),
  trackAnalytics: ({ event }) =>
    Analytics.track(event),
})
```

**Important**: Effects in handlers run inline during transition. For long-running effects, use `.spawn()`.

## Conditional Transitions

Use standard control flow:

```ts
.on(State.Processing, Event.Complete, ({ state, event }) => {
  if (event.success) {
    return State.Success({ data: event.data });
  }
  if (state.retryCount < 3) {
    return State.Retrying({ count: state.retryCount + 1 });
  }
  return State.Failed({ reason: "Max retries exceeded" });
})
```

Or with `$match`:

```ts
.on(State.Processing, Event.Result, ({ event }) =>
  Event.$match(event, {
    Result: ({ status }) =>
      status === "ok"
        ? State.Success({ data: event.data })
        : State.Failed({ reason: event.error }),
  })
)
```

## Same-State Transitions

By default, transitioning to the same state tag skips lifecycle effects:

```ts
// Updates state data but doesn't re-run spawn effects
.on(State.Active, Event.Update, ({ event }) =>
  State.Active({ count: event.count })
)
```

Use `.reenter()` to force lifecycle even on same tag:

```ts
// Forces spawn effects to restart (e.g., reset a timer)
.reenter(State.Active, Event.Reset, ({ state }) =>
  State.Active({ count: 0 })
)
```

## Accessing State Data

State is typed based on the source state:

```ts
.on(State.Loading, Event.Tick, ({ state }) => {
  // TypeScript knows state is Loading
  console.log(state.url);           // ✓ url exists on Loading
  console.log(state.data);          // ✗ data doesn't exist on Loading
  return state;
})
```

For shared transitions, use type narrowing:

```ts
// Registered for multiple states
.on(State.Loading, Event.Cancel, ({ state }) => State.Cancelled)
.on(State.Processing, Event.Cancel, ({ state }) => State.Cancelled)
```

## Error Handling

Use Effect error handling in async handlers:

```ts
.on(State.Loading, Event.Fetch, ({ state, effects }) =>
  Effect.gen(function* () {
    const result = yield* effects.fetch({ url: state.url }).pipe(
      Effect.catchTag("NetworkError", () =>
        Effect.succeed({ error: "Network failed" })
      )
    );

    if (result.error) {
      return State.Error({ message: result.error });
    }
    return State.Success({ data: result.data });
  })
)
```

**Never throw** inside `Effect.gen` - use `yield* Effect.fail()` or return error states.

## See Also

- `basics.md` - Core concepts
- `effects.md` - spawn and background effects
- `gotchas.md` - Common mistakes
