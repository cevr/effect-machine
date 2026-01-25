# Guards

Conditional transitions with composable guard functions.

## Basic Guards

Inline guard on a transition:

```typescript
on(State.Form, Event.Submit, () => State.Submitting(), {
  guard: ({ state }) => state.isValid,
});
```

If guard returns `false`, transition is skipped.

## Reusable Guards

Create named guards with `Guard.make`:

```typescript
import { GuardModule as Guard } from "effect-machine";

const isValid = Guard.make<FormState, SubmitEvent>(({ state }) => state.isValid);

const hasEmail = Guard.make<FormState, SubmitEvent>(({ state }) => state.email.length > 0);

on(State.Form, Event.Submit, () => State.Submitting(), {
  guard: isValid,
});
```

## Guard Composition

### Guard.and

Both guards must pass:

```typescript
const canSubmit = Guard.and(isValid, hasEmail);

on(State.Form, Event.Submit, () => State.Submitting(), {
  guard: canSubmit,
});
```

### Guard.or

Either guard can pass:

```typescript
const isAdmin = Guard.make(({ state }) => state.role === "admin");
const isModerator = Guard.make(({ state }) => state.role === "moderator");

const canModerate = Guard.or(isAdmin, isModerator);

on(State.LoggedIn, Event.Moderate, () => State.Moderating(), {
  guard: canModerate,
});
```

### Guard.not

Negate a guard:

```typescript
const isGuest = Guard.make(({ state }) => state.role === "guest");
const isNotGuest = Guard.not(isGuest);

on(State.LoggedIn, Event.AccessDashboard, () => State.Dashboard(), {
  guard: isNotGuest,
});
```

## Complex Compositions

Guards compose naturally:

```typescript
const isAdmin = Guard.make(({ state }) => state.role === "admin");
const isActive = Guard.make(({ state }) => state.active);
const isNotBanned = Guard.not(Guard.make(({ state }) => state.banned));

// Admin AND active AND not banned
const canAccessAdmin = Guard.and(Guard.and(isAdmin, isActive), isNotBanned);
```

## Type Narrowing

Guards can be typed to specific state/event combinations:

```typescript
type IdleState = State & { readonly _tag: "Idle" };
type StartEvent = Event & { readonly _tag: "Start" };

const canStart = Guard.make<IdleState, StartEvent>(({ state, event }) => {
  // state is narrowed to IdleState
  // event is narrowed to StartEvent
  return state.ready && event.force;
});
```

## Guard Cascade Order

When multiple transitions match the same state + event, guards are evaluated in **registration order**:

```typescript
// First registered, first checked
on(State.A, Event.X, () => State.B(), {
  guard: ({ state }) => state.value > 100,  // Checked first
}),
on(State.A, Event.X, () => State.C(), {
  guard: ({ state }) => state.value > 50,   // Checked second
}),
on(State.A, Event.X, () => State.D()),      // Fallback (no guard)
```

First passing guard wins. Use `choose` for explicit cascade:

```typescript
choose(State.A, Event.X, [
  { guard: ({ state }) => state.value > 100, to: () => State.B() },
  { guard: ({ state }) => state.value > 50, to: () => State.C() },
  { otherwise: true, to: () => State.D() },
]);
```

## Guards in always

`always` transitions use simpler guards (state only, no event):

```typescript
always(State.Calculating, [
  { guard: (state) => state.value >= 70, to: () => State.High() },
  { guard: (state) => state.value >= 40, to: () => State.Medium() },
  { otherwise: true, to: () => State.Low() },
]);
```

## Testing Guards

Test guards in isolation:

```typescript
import { GuardModule as Guard } from "effect-machine";

const isValid = Guard.make<FormState, SubmitEvent>(({ state }) => state.email.includes("@"));

test("isValid passes for valid email", () => {
  const ctx = {
    state: State.Form({ email: "test@example.com" }),
    event: Event.Submit(),
  };
  expect(isValid(ctx)).toBe(true);
});

test("isValid fails for invalid email", () => {
  const ctx = {
    state: State.Form({ email: "invalid" }),
    event: Event.Submit(),
  };
  expect(isValid(ctx)).toBe(false);
});
```

## See Also

- `combinators.md` - all combinators
- `testing.md` - testing patterns
- `basics.md` - core concepts
