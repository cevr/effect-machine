# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── machine.ts            # Core types (Machine, MachineBuilder, Transition, OnOptions)
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── combinators/
│   ├── on.ts             # State/event transitions (on, on.force)
│   ├── final.ts          # Final state marker
│   ├── always.ts         # Eventless transitions
│   ├── choose.ts         # Guard cascade for events
│   ├── delay.ts          # Delayed events (static or dynamic duration)
│   ├── assign.ts         # Partial state updates (assign, update)
│   ├── invoke.ts         # Async effect with auto-cancel
│   ├── on-enter.ts       # State entry effects
│   └── on-exit.ts        # State exit effects
└── internal/
    ├── loop.ts           # Event loop, transition resolver, actor creation
    ├── types.ts          # Internal types (contexts, Guard module)
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
│   ├── guard-composition.test.ts
│   ├── internal-transitions.test.ts
│   └── reenter.test.ts
└── patterns/             # Real-world pattern tests (from bite analysis)
    ├── payment-flow.test.ts      # Guard cascade, retry, cancellation
    ├── session-lifecycle.test.ts # Always transitions, timeout
    ├── keyboard-input.test.ts    # Mode switching, internal transitions
    └── menu-navigation.test.ts   # Guard-based routing
```

## Key Files

| File                | Purpose                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `internal/loop.ts`  | Event processing, `resolveTransition`, `applyAlways`, `createActor` |
| `internal/types.ts` | `TransitionContext`, `StateEffectContext`, `Guard` module           |
| `machine.ts`        | `Machine`, `MachineBuilder`, `Transition`, `OnOptions` interfaces   |
| `actor-ref.ts`      | `ActorRef` interface with ergonomic helpers                         |
| `testing.ts`        | `simulate`, `createTestHarness`, `assertPath`, `assertNeverReaches` |
| `delay.ts`          | `DurationOrFn`, WeakMap fiber storage pattern                       |
| `invoke.ts`         | WeakMap fiber storage pattern (same as delay)                       |

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

`delay.ts` and `invoke.ts` use WeakMap for per-actor, per-combinator fiber storage:

```ts
const actorFibers = new WeakMap<MachineRef<unknown>, Map<symbol, Fiber>>();
const instanceKey = Symbol("delay"); // unique per combinator instance
```

- Prevents closure-based fiber leaks across actor instances
- Symbol key allows multiple delays/invokes per state

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
