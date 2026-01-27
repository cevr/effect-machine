# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── namespace.ts          # Machine namespace (Effect-style API)
├── state.ts              # Branded State.TaggedEnum wrapper
├── event.ts              # Branded Event.TaggedEnum wrapper
├── machine.ts            # Core types (Machine, MachineBuilder, Transition, OnOptions)
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── combinators/
│   ├── on.ts             # State/event transitions (on, on.force, scoped variant)
│   ├── from.ts           # State scoping (Machine.from(State).pipe(...))
│   ├── any.ts            # Multi-state matcher (Machine.any(S1, S2, ...))
│   ├── final.ts          # Final state marker
│   ├── always.ts         # Eventless transitions
│   ├── choose.ts         # Guard cascade for events
│   ├── delay.ts          # Delayed events (static or dynamic duration)
│   ├── assign.ts         # Partial state updates (assign, update)
│   ├── invoke.ts         # Named invoke slot (effect provided via Machine.provide)
│   ├── on-enter.ts       # Named onEnter slot (effect provided via Machine.provide)
│   ├── on-exit.ts        # Named onExit slot (effect provided via Machine.provide)
│   └── provide.ts        # Machine.provide - wires effect handlers to slots
└── internal/
    ├── loop.ts           # Event loop, transition resolver, actor creation
    ├── types.ts          # Internal types (contexts, Guard module)
    ├── brands.ts         # StateBrand/EventBrand phantom types
    └── get-tag.ts        # Tag extraction from constructors

test/
├── machine.test.ts       # Core machine tests
├── actor-system.test.ts  # Actor spawning/lifecycle
├── actor-ref.test.ts     # ActorRef ergonomics (snapshot, matches, can, subscribe)
├── testing.test.ts       # Test utilities (assertPath, assertNeverReaches, onTransition)
├── features/             # Feature-specific tests
│   ├── always-transitions.test.ts
│   ├── assign-update.test.ts
│   ├── choose.test.ts
│   ├── delay.test.ts
│   ├── dynamic-delay.test.ts
│   ├── from-any.test.ts          # Machine.from() and Machine.any() combinators
│   ├── guard-composition.test.ts
│   ├── internal-transitions.test.ts
│   └── reenter.test.ts
└── patterns/             # Real-world pattern tests (from bite analysis)
    ├── payment-flow.test.ts      # Guard cascade, retry, Machine.any() for Cancel
    ├── session-lifecycle.test.ts # Machine.from() scoping, always transitions, timeout
    ├── keyboard-input.test.ts    # Machine.from() scoping, mode switching
    └── menu-navigation.test.ts   # Machine.from() scoping, guard-based routing
```

## Key Files

| File                     | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `state.ts`               | Branded `State.TaggedEnum` wrapper - prevents State/Event mixup     |
| `event.ts`               | Branded `Event.TaggedEnum` wrapper - prevents State/Event mixup     |
| `internal/brands.ts`     | `StateBrand`/`EventBrand` using Effect's `Brand` (phantom types)    |
| `namespace.ts`           | Machine namespace export (named `namespace.ts` for macOS compat)    |
| `internal/loop.ts`       | Event processing, `resolveTransition`, `applyAlways`, `createActor` |
| `internal/types.ts`      | `TransitionContext`, `StateEffectContext`, `Guard` module           |
| `machine.ts`             | `Machine`, `MachineBuilder`, `Transition`, `OnOptions` interfaces   |
| `actor-ref.ts`           | `ActorRef` interface with ergonomic helpers                         |
| `testing.ts`             | `simulate`, `createTestHarness`, `assertPath`, `assertNeverReaches` |
| `combinators/from.ts`    | `StateScope` for scoped transitions, custom `.pipe()` impl          |
| `combinators/any.ts`     | `StateMatcher` interface, multi-state matching                      |
| `combinators/provide.ts` | `Machine.provide` - wires handlers to effect slots                  |
| `delay.ts`               | `DurationOrFn`, WeakMap fiber storage pattern                       |
| `invoke.ts`              | Effect slot registration (handler provided via `Machine.provide`)   |

## Event Flow

```
Event → resolveTransition (guard cascade) → onExit → handler → applyAlways → onEnter → update state
```

- Guard cascade: first passing guard wins (registration order)
- Same-state transitions skip onExit/onEnter by default
- `on.force()`: force onExit/onEnter even for same state tag
- `applyAlways`: loops until no match or final state (max 100 iterations)
- Final states stop the actor

## Fiber Storage Pattern

`delay.ts` and `provide.ts` use WeakMap for per-actor, per-combinator fiber storage:

```ts
const actorFibers = new WeakMap<MachineRef<unknown>, Map<symbol, Fiber>>();
const instanceKey = Symbol("delay"); // unique per combinator instance
```

- Prevents closure-based fiber leaks across actor instances
- Symbol key allows multiple delays/invokes per state

## Effect Slots Pattern

`invoke`, `onEnter`, `onExit` register named slots, not inline handlers:

```ts
Machine.invoke(State.Loading, "fetchData")  // registers slot
Machine.provide(machine, { fetchData: ... }) // wires handler
```

- Slots tracked in `Machine.effectSlots: Map<string, EffectSlot>`
- `Machine.provide` builds actual `StateEffect` entries from slots + handlers
- Spawning validates all slots have handlers (runtime check)
- `simulate()` ignores effects - works with unprovided machines

## Testing

| Function              | Effects | Always | Observer |
| --------------------- | ------- | ------ | -------- |
| `simulate`            | No      | Yes    | No       |
| `createTestHarness`   | No      | Yes    | Yes      |
| Actor + `yieldFibers` | Yes     | Yes    | No       |

- `assertPath(machine, events, ["S1", "S2", ...])` - verify exact state sequence
- `assertNeverReaches(machine, events, "Forbidden")` - verify state never visited
- `onTransition: (from, event, to) => void` - spy on transitions

Use `Layer.merge(ActorSystemDefault, TestContext.TestContext)` for TestClock.

## ActorRef API

| Method         | Effect | Sync | Purpose                                   |
| -------------- | ------ | ---- | ----------------------------------------- |
| `snapshot`     | ✓      | -    | Get current state                         |
| `snapshotSync` | -      | ✓    | Get current state (sync)                  |
| `matches`      | ✓      | -    | Check if state matches tag                |
| `matchesSync`  | -      | ✓    | Check if state matches tag (sync)         |
| `can`          | ✓      | -    | Check if event can be handled (w/ guards) |
| `canSync`      | -      | ✓    | Check if event can be handled (sync)      |
| `changes`      | Stream | -    | Stream of state updates                   |
| `subscribe`    | -      | ✓    | Sync callback, returns unsubscribe fn     |

- `can`/`canSync` evaluate guards - returns `true` only if transition exists AND guards pass
- `subscribe` callback fires on each state change; `changes` stream excludes initial value
