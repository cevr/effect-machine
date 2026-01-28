# Guards

Conditional transitions with parameterized guard slots.

## Defining Guards

Guards are defined via `Slot.Guards` with optional schema parameters:

```typescript
import { Slot } from "effect-machine";
import { Schema } from "effect";

const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number }, // parameterized guard
  isValid: {}, // no parameters
  hasPermission: { resource: Schema.String },
});
```

## Using Guards in Machine

Pass guards to `Machine.make`, then use in handlers:

```typescript
const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Submit, ({ state, guards }) =>
    Effect.gen(function* () {
      if (yield* guards.isValid()) {
        return MyState.Submitting;
      }
      return state; // stay in current state
    }),
  )
  .on(MyState.Error, MyEvent.Retry, ({ state, guards }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        return MyState.Retrying({ attempts: state.attempts + 1 });
      }
      return MyState.Failed;
    }),
  );
```

## Providing Guard Implementations

Provide implementations via `.provide()` with `(params, ctx)` signature:

```typescript
const provided = machine.provide({
  // Sync - return boolean
  isValid: (_params, { state }) => state.email.includes("@"),

  // With params
  canRetry: ({ max }, { state }) => state.attempts < max,

  // Async - return Effect<boolean>
  hasPermission: ({ resource }, { state }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.check(state.userId, resource);
    }),
});
```

The `ctx` object contains:

- `state` - current machine state
- `event` - triggering event
- `self` - actor reference for sending events

## Multiple Guard Checks

Combine guards with plain JavaScript logic:

```typescript
.on(MyState.Form, MyEvent.Submit, ({ state, guards }) =>
  Effect.gen(function* () {
    const valid = yield* guards.isValid();
    const permitted = yield* guards.hasPermission({ resource: "submit" });

    if (valid && permitted) {
      return MyState.Submitting;
    }
    if (!valid) {
      return MyState.ValidationError;
    }
    return MyState.PermissionDenied;
  })
)
```

## Guards in spawn

Guard checks in spawn effects:

```typescript
machine.spawn(MyState.Active, ({ state, guards }) =>
  Effect.gen(function* () {
    if (yield* guards.shouldNotify()) {
      yield* NotificationService.send("User active");
    }
  }),
);
```

## Type Safety

Guard parameters are fully typed from the schema:

```typescript
const MyGuards = Slot.Guards({
  checkLimit: { min: Schema.Number, max: Schema.Number },
});

// TypeScript enforces parameter types
guards.checkLimit({ min: 0, max: 100 }); // OK
guards.checkLimit({ min: "0" }); // Type error!
```

## See Also

- `combinators.md` - all combinators
- `testing.md` - testing patterns
- `basics.md` - core concepts
