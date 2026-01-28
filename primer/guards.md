# Guards

Conditional transitions with composable guard slots.

## Guard Slots

Guards are **slots-only** - declare with a name, provide implementation via `.provide()`:

```typescript
import { Guard } from "effect-machine";

// Declare guard slot
const isValid = Guard.make("isValid");

// Use in transition
machine.on(State.Form, Event.Submit, () => State.Submitting, {
  guard: isValid,
});

// Provide implementation
const provided = machine.provide({
  isValid: ({ state }) => state.email.includes("@"),
});
```

## Guard Handlers

Handlers can return `boolean` (sync) or `Effect<boolean>` (async):

```typescript
machine.provide({
  // Sync - simple boolean
  isValid: ({ state }) => state.email.includes("@"),

  // Async - Effect<boolean> (adds R to machine type)
  hasPermission: ({ state }) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.check(state.userId);
    }),
});
```

## Guard Composition

### String Shorthand

Compose guards using string names directly:

```typescript
Guard.and("isValid", "hasEmail");
Guard.or("isAdmin", "isModerator");
Guard.not("isBanned");
```

### Guard.and

All guards must pass (evaluated in parallel):

```typescript
const canSubmit = Guard.and("isValid", "hasEmail");

machine.on(State.Form, Event.Submit, () => State.Submitting, {
  guard: canSubmit,
});
```

### Guard.or

Any guard can pass (evaluated in parallel):

```typescript
const canModerate = Guard.or("isAdmin", "isModerator");

machine.on(State.LoggedIn, Event.Moderate, () => State.Moderating, {
  guard: canModerate,
});
```

### Guard.not

Negate a guard:

```typescript
const isNotGuest = Guard.not("isGuest");

machine.on(State.LoggedIn, Event.AccessDashboard, () => State.Dashboard, {
  guard: isNotGuest,
});
```

## Nested Composition

Guards compose hierarchically:

```typescript
// (admin OR moderator) AND active AND NOT banned
const canAccessAdmin = Guard.and(
  Guard.or("isAdmin", "isModerator"),
  "isActive",
  Guard.not("isBanned"),
);

// Provide all leaf guards
machine.provide({
  isAdmin: ({ state }) => state.role === "admin",
  isModerator: ({ state }) => state.role === "moderator",
  isActive: ({ state }) => state.active,
  isBanned: ({ state }) => state.banned,
});
```

## Parallel Evaluation

Composition guards evaluate their children in parallel:

```typescript
// isAdmin and isActive checked simultaneously
Guard.and("isAdmin", "isActive");
```

This is especially useful for async guards that hit external services.

## Guard Cascade Order

When multiple transitions match the same state + event, guards are evaluated in **registration order**:

```typescript
// First registered, first checked
machine
  .on(State.A, Event.X, () => State.B, {
    guard: Guard.make("highValue"), // Checked first
  })
  .on(State.A, Event.X, () => State.C, {
    guard: Guard.make("mediumValue"), // Checked second
  })
  .on(State.A, Event.X, () => State.D); // Fallback (no guard)
```

First passing guard wins. Use `choose` for explicit cascade:

```typescript
machine.choose(State.A, Event.X, [
  { guard: Guard.make("highValue"), to: () => State.B },
  { guard: Guard.make("mediumValue"), to: () => State.C },
  { to: () => State.D }, // Fallback (no guard)
]);
```

## Guards in always

`always` transitions use simpler guards (state only, no event):

```typescript
machine.always(State.Calculating, [
  { guard: Guard.make("isHigh"), to: () => State.High },
  { guard: Guard.make("isMedium"), to: () => State.Medium },
  { to: () => State.Low }, // Fallback (no guard)
]);
```

## See Also

- `combinators.md` - all combinators
- `testing.md` - testing patterns
- `basics.md` - core concepts
