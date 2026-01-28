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
import { Effect, Schema } from "effect";
import { Machine, State, Event, simulate } from "effect-machine";

const MyState = State({
  Idle: {},
  Loading: {},
  Done: { result: Schema.String },
});
type MyState = typeof MyState.Type;

const MyEvent = Event({
  Start: {},
  Complete: { result: Schema.String },
});
type MyEvent = typeof MyEvent.Type;

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, () => MyState.Loading)
  .on(MyState.Loading, MyEvent.Complete, ({ event }) => MyState.Done({ result: event.result }))
  .final(MyState.Done);

// Test it
const result = await Effect.runPromise(
  simulate(machine, [MyEvent.Start, MyEvent.Complete({ result: "ok" })]),
);
console.log(result.finalState._tag); // "Done"
```

## Key Concepts

| Concept        | Description                                         |
| -------------- | --------------------------------------------------- |
| **State**      | Branded type representing machine state             |
| **Event**      | Branded type representing inputs                    |
| **Transition** | State + Event → New State                           |
| **Guard**      | Boolean predicate that enables/disables transitions |
| **Spawn**      | State-scoped effect slot (cancelled on exit)        |
| **Background** | Machine-lifetime effect slot                        |
| **Final**      | Terminal state - no transitions out                 |

## API Quick Reference

### Building

| Function                | Purpose                          |
| ----------------------- | -------------------------------- |
| `Machine.make(initial)` | Start machine with initial state |
| `Machine.on(...)`       | Add transition                   |
| `Machine.final(state)`  | Mark state as final              |

### Combinators

| Function                                 | Purpose                                     |
| ---------------------------------------- | ------------------------------------------- |
| `Machine.choose(state, event, branches)` | Guard cascade                               |
| `Machine.delay(state, duration, event)`  | Auto-send event after delay                 |
| `Machine.spawn(state, handler)`          | State-scoped effect (calls effect slot)     |
| `Machine.background(handler)`            | Machine-lifetime effect (calls effect slot) |
| `Machine.provide(machine, handlers)`     | Wire handlers to slots                      |

### Guards

| Function          | Purpose            |
| ----------------- | ------------------ |
| `Slot.Guards`     | Define guard slots |
| `Guard.and(a, b)` | Both must pass     |
| `Guard.or(a, b)`  | Either can pass    |
| `Guard.not(g)`    | Negate guard       |

### Testing

| Function                                | Purpose                    |
| --------------------------------------- | -------------------------- |
| `simulate(machine, events)`             | Run events, get all states |
| `createTestHarness(machine)`            | Step-by-step testing       |
| `assertReaches(machine, events, state)` | Assert final state         |

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
