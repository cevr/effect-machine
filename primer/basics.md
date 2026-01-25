# Basics

Core concepts for building state machines with effect-machine.

## States and Events

States and events are tagged enums using Effect's `Data.TaggedEnum`:

```typescript
import { Data } from "effect";

// States - what the machine can be
type State = Data.TaggedEnum<{
  Idle: {};
  Loading: { url: string };
  Success: { data: string };
  Error: { message: string };
}>;
const State = Data.taggedEnum<State>();

// Events - what can happen
type Event = Data.TaggedEnum<{
  Fetch: { url: string };
  Resolve: { data: string };
  Reject: { message: string };
}>;
const Event = Data.taggedEnum<Event>();
```

**Why tagged enums?**

- Exhaustive pattern matching
- Type narrowing in handlers
- Structural equality for testing

## Building Machines

Use `pipe` to compose a machine definition:

```typescript
import { pipe } from "effect";
import { build, final, make, on } from "effect-machine";

const machine = build(
  pipe(
    // Initial state
    make<State, Event>(State.Idle()),

    // Transitions: from state + event → new state
    on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
    on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
    on(State.Loading, Event.Reject, ({ event }) => State.Error({ message: event.message })),

    // Final states (no transitions out)
    final(State.Success),
    final(State.Error),
  ),
);
```

## Transition Handlers

Handlers receive a context object with `state` and `event`:

```typescript
on(State.Loading, Event.Resolve, ({ state, event }) => {
  // state is narrowed to Loading
  // event is narrowed to Resolve
  return State.Success({ data: event.data });
});
```

### Returning Effects

Handlers can return an Effect for async transitions:

```typescript
on(State.Idle, Event.Fetch, ({ event }) =>
  Effect.gen(function* () {
    const data = yield* fetchData(event.url);
    return State.Success({ data });
  }),
);
```

## Guards

Conditionally enable transitions:

```typescript
on(State.Form, Event.Submit, ({ state }) => State.Submitting(), {
  guard: ({ state }) => state.isValid,
});
```

If guard returns `false`, the transition is skipped and state remains unchanged.

## Effects

Run side effects on transitions:

```typescript
on(State.Idle, Event.Start, () => State.Running(), {
  effect: ({ state, event }) => Effect.log(`Starting from ${state._tag} with ${event._tag}`),
});
```

Effects run after the state change is committed.

## Final States

Mark states as terminal:

```typescript
final(State.Success),
final(State.Error),
```

Once in a final state:

- No transitions are processed
- Actor stops automatically

## State Entry/Exit

Run effects when entering or exiting states:

```typescript
import { onEnter, onExit } from "effect-machine";

pipe(
  make<State, Event>(State.Idle()),
  onEnter(State.Loading, ({ state, self }) =>
    Effect.gen(function* () {
      const data = yield* fetchData(state.url);
      yield* self.send(Event.Resolve({ data }));
    }),
  ),
  onExit(State.Loading, () => Effect.log("Leaving Loading")),
);
```

`self.send` lets you send events back to the machine from effects.

## Eventless Transitions (always)

Transitions that fire immediately based on state:

```typescript
import { always } from "effect-machine";

pipe(
  make<State, Event>(State.Calculating({ value: 75 })),
  always(State.Calculating, [
    { guard: (s) => s.value >= 70, to: (s) => State.High({ value: s.value }) },
    { guard: (s) => s.value >= 40, to: (s) => State.Medium({ value: s.value }) },
    { otherwise: true, to: (s) => State.Low({ value: s.value }) },
  ]),
);
```

Branches are evaluated top-to-bottom. First match wins.

## Delayed Events

Auto-send events after a duration:

```typescript
import { delay } from "effect-machine";

pipe(
  make<State, Event>(State.Success({ message: "Done" })),
  on(State.Success, Event.Dismiss, () => State.Dismissed()),
  delay(State.Success, "3 seconds", Event.Dismiss()),
);
```

Timer is cancelled if state exits before duration.

## See Also

- `combinators.md` - all combinators in detail
- `guards.md` - guard composition
- `testing.md` - testing your machines
