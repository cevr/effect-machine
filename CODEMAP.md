# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── machine.ts            # Core types (Machine, MachineBuilder, Transition)
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── combinators/
│   ├── on.ts             # State/event transitions
│   ├── final.ts          # Final state marker
│   ├── always.ts         # Eventless transitions
│   ├── choose.ts         # Guard cascade for events
│   ├── delay.ts          # Delayed event scheduling
│   ├── assign.ts         # Partial state updates (assign, update)
│   ├── invoke.ts         # Async effect with auto-cancel
│   ├── on-enter.ts       # State entry effects
│   └── on-exit.ts        # State exit effects
└── internal/
    ├── loop.ts           # Event loop, transition resolver, actor creation
    ├── types.ts          # Internal types (contexts, guards)
    └── get-tag.ts        # Tag extraction from constructors

test/
├── Machine.test.ts
├── ActorSystem.test.ts
├── Testing.test.ts
└── features/
    ├── always-transitions.test.ts
    ├── assign-update.test.ts
    ├── choose.test.ts
    ├── delay.test.ts
    └── guard-composition.test.ts
```

## Key Files

| File | Purpose |
|------|---------|
| `internal/loop.ts` | Event processing, `resolveTransition`, `applyAlways`, `createActor` |
| `internal/types.ts` | `TransitionContext`, `StateEffectContext`, `Guard` module |
| `machine.ts` | `Machine`, `MachineBuilder`, `Transition`, `AlwaysTransition` interfaces |
| `testing.ts` | Pure testing: `simulate`, `createTestHarness`, `assertReaches` |

## Event Flow

```
Event → resolveTransition (guard cascade) → onExit → handler → applyAlways → onEnter → update state
```

- Guard cascade: first passing guard wins (registration order)
- `applyAlways`: loops until no match or final state (max 100 iterations)
- Final states stop the actor

## Actor Lifecycle

```
spawn → createActor → SubscriptionRef + Queue + fiber → process events → final state or stop()
```

- Scope finalization interrupts fibers
- `ActorSystemDefault` layer required

## Testing

| Function | Effects | Always |
|----------|---------|--------|
| `simulate` | No | Yes |
| `createTestHarness` | No | Yes |
| Actor + `yieldFibers` | Yes | Yes |

Use `Layer.merge(ActorSystemDefault, TestContext.TestContext)` for TestClock.
