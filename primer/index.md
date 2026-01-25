# effect-machine

Type-safe state machines for Effect. XState-inspired, Effect-native.

## When to Use

- Complex UI flows (checkout, wizards, forms)
- Async workflows with retry/timeout logic
- Protocol implementations
- Game state management
- Anywhere state + events + effects intersect

## Navigation

```
What are you doing?
├─ Learning the basics        → basics.md
├─ Adding transitions         → combinators.md
├─ Composing guards           → guards.md
├─ Writing tests              → testing.md
├─ Using actors               → actors.md
└─ Understanding internals    → ../CODEMAP.md
```

## Topic Index

| Topic             | File             | When to Read          |
| ----------------- | ---------------- | --------------------- |
| Core concepts     | `basics.md`      | New to effect-machine |
| All combinators   | `combinators.md` | Building machines     |
| Guard composition | `guards.md`      | Complex conditions    |
| Testing patterns  | `testing.md`     | Writing tests         |
| Actor system      | `actors.md`      | Running machines      |

## Quick Example

```typescript
import { Data, Effect, pipe } from "effect";
import { build, final, make, on, simulate } from "effect-machine";

type State = Data.TaggedEnum<{
  Idle: {};
  Loading: {};
  Done: { result: string };
}>;
const State = Data.taggedEnum<State>();

type Event = Data.TaggedEnum<{
  Start: {};
  Complete: { result: string };
}>;
const Event = Data.taggedEnum<Event>();

const machine = build(
  pipe(
    make<State, Event>(State.Idle()),
    on(State.Idle, Event.Start, () => State.Loading()),
    on(State.Loading, Event.Complete, ({ event }) => State.Done({ result: event.result })),
    final(State.Done),
  ),
);

// Test it
const result = await Effect.runPromise(
  simulate(machine, [Event.Start(), Event.Complete({ result: "ok" })]),
);
console.log(result.finalState._tag); // "Done"
```

## Key Concepts

| Concept        | Description                                         |
| -------------- | --------------------------------------------------- |
| **State**      | Tagged enum representing machine state              |
| **Event**      | Tagged enum representing inputs                     |
| **Transition** | State + Event → New State                           |
| **Guard**      | Boolean predicate that enables/disables transitions |
| **Effect**     | Side effect run on transition or state entry/exit   |
| **Final**      | Terminal state - no transitions out                 |

## API Quick Reference

### Building

| Function                              | Purpose                          |
| ------------------------------------- | -------------------------------- |
| `make(initial)`                       | Start builder with initial state |
| `build(builder)`                      | Finalize machine definition      |
| `on(state, event, handler, options?)` | Add transition                   |
| `final(state)`                        | Mark state as final              |

### Combinators

| Function                         | Purpose                     |
| -------------------------------- | --------------------------- |
| `always(state, branches)`        | Eventless transitions       |
| `choose(state, event, branches)` | Guard cascade               |
| `delay(state, duration, event)`  | Auto-send event after delay |
| `assign(updater)`                | Partial state update helper |
| `update(state, event, updater)`  | Shorthand for on + assign   |
| `invoke(state, handler)`         | Run effect, cancel on exit  |
| `onEnter(state, handler)`        | Effect on state entry       |
| `onExit(state, handler)`         | Effect on state exit        |

### Guards

| Function          | Purpose               |
| ----------------- | --------------------- |
| `Guard.make(fn)`  | Create reusable guard |
| `Guard.and(a, b)` | Both must pass        |
| `Guard.or(a, b)`  | Either can pass       |
| `Guard.not(g)`    | Negate guard          |

### Testing

| Function                                | Purpose                    |
| --------------------------------------- | -------------------------- |
| `simulate(machine, events)`             | Run events, get all states |
| `createTestHarness(machine)`            | Step-by-step testing       |
| `assertReaches(machine, events, state)` | Assert final state         |
| `yieldFibers`                           | Yield to background fibers |

### Actors

| Export               | Purpose                      |
| -------------------- | ---------------------------- |
| `ActorSystemService` | Service tag for actor system |
| `ActorSystemDefault` | Default layer                |

## See Also

- `basics.md` - core concepts in depth
- `combinators.md` - all combinators explained
- `guards.md` - guard composition patterns
- `testing.md` - testing strategies
- `actors.md` - actor system usage
