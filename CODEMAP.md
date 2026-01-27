# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── namespace.ts          # Machine namespace (Effect-style API)
├── machine-schema.ts     # Schema-first State/Event (MachineStateSchema, MachineEventSchema)
├── machine.ts            # Core types (Machine, MakeConfig, Transition)
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── inspection.ts         # Inspector service for debugging
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
├── persistence/
│   ├── adapter.ts        # PersistenceAdapter interface + tags
│   ├── persistent-machine.ts  # Machine.persist combinator
│   ├── persistent-actor.ts    # PersistentActorRef implementation
│   └── in-memory.ts      # InMemoryPersistenceAdapter
├── cluster/
│   ├── index.ts          # Cluster exports
│   └── to-entity.ts      # toEntity - generates Entity from machine
└── internal/
    ├── loop.ts           # Event loop, transition resolver, lifecycle effects
    ├── transition-index.ts # O(1) lookup for transitions and effects
    ├── fiber-storage.ts  # Per-actor WeakMap fiber storage utility
    ├── types.ts          # Internal types (contexts, Guard module)
    ├── brands.ts         # StateBrand/EventBrand + BrandedState/BrandedEvent
    └── get-tag.ts        # Tag extraction from constructors

test/
├── machine.test.ts       # Core machine tests
├── actor-system.test.ts  # Actor spawning/lifecycle
├── actor-ref.test.ts     # ActorRef ergonomics
├── persistence.test.ts   # Persistence tests
├── testing.test.ts       # Test utilities
├── machine-schema.test.ts # Schema-first State/Event tests
├── transition-index.test.ts # O(1) transition lookup tests
├── inspection.test.ts    # Inspector tests
├── features/             # Feature-specific tests
│   ├── always.test.ts
│   ├── any.test.ts
│   ├── assign.test.ts
│   ├── choose.test.ts
│   ├── delay.test.ts
│   ├── dynamic-delay.test.ts
│   ├── effects.test.ts
│   ├── force.test.ts
│   ├── from.test.ts
│   ├── guards.test.ts
│   └── same-state.test.ts
├── patterns/             # Real-world pattern tests
│   ├── payment-flow.test.ts
│   ├── session-lifecycle.test.ts
│   ├── keyboard-input.test.ts
│   └── menu-navigation.test.ts
└── integration/
    └── cluster.test.ts   # @effect/cluster integration
```

## Key Files

| File                                | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `machine-schema.ts`                 | Schema-first `State`/`Event` - single source of truth    |
| `machine.ts`                        | `Machine.make({ state, event, initial })` + core types   |
| `namespace.ts`                      | Machine namespace export (named for macOS compat)        |
| `internal/loop.ts`                  | Event processing, `resolveTransition`, lifecycle effects |
| `internal/transition-index.ts`      | O(1) lookup for transitions, always, onEnter, onExit     |
| `internal/brands.ts`                | Branded types: `StateBrand`, `BrandedState`, etc.        |
| `internal/fiber-storage.ts`         | `createFiberStorage()` - per-actor WeakMap utility       |
| `persistence/persistent-machine.ts` | `Machine.persist` - schemas from machine, no drift       |
| `cluster/to-entity.ts`              | `toEntity` - schemas from machine, no drift              |

## Event Flow

```
Event → resolveTransition (guard cascade) → onExit → handler → applyAlways → onEnter → update state
```

- Guard cascade: first passing guard wins (registration order)
- Same-state transitions skip onExit/onEnter by default
- `on.force()`: force onExit/onEnter even for same state tag
- `applyAlways`: loops until no match or final state (max 100 iterations)
- Final states stop the actor

## Schema-First Pattern

State and Event ARE schemas. `Machine.make` requires them:

```ts
const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
});
type MyState = typeof MyState.Type;

const machine = Machine.make({
  state: MyState, // required - becomes machine.stateSchema
  event: MyEvent, // required - becomes machine.eventSchema
  initial: MyState.Idle(),
});
```

- Types inferred from schemas - no manual type params
- `persist()` and `toEntity()` read schemas from machine - no drift possible
- `$match` and `$is` helpers for pattern matching

## Fiber Storage Pattern

`delay.ts` and `provide.ts` use shared utility from `internal/fiber-storage.ts`:

```ts
import { createFiberStorage } from "../internal/fiber-storage.js";

const getFiberMap = createFiberStorage(); // WeakMap-backed, per-actor
const instanceKey = Symbol("delay"); // unique per combinator instance
getFiberMap(self).set(instanceKey, fiber);
```

## Transition Index

`internal/transition-index.ts` provides O(1) lookup via lazy-built WeakMap cache:

- `findTransitions(machine, stateTag, eventTag)` - event transitions
- `findAlwaysTransitions(machine, stateTag)` - always transitions
- `findOnEnterEffects(machine, stateTag)` - entry effects
- `findOnExitEffects(machine, stateTag)` - exit effects

Index built on first access, cached per machine instance.

## Effect Slots Pattern

`invoke`, `onEnter`, `onExit` register named slots:

```ts
Machine.invoke(State.Loading, "fetchData")  // registers slot
Machine.provide(machine, { fetchData: ... }) // wires handler
```

- Spawning validates all slots have handlers (runtime check)
- `simulate()` ignores effects - works with unprovided machines

## Testing

| Function              | Effects | Always | Observer |
| --------------------- | ------- | ------ | -------- |
| `simulate`            | No      | Yes    | No       |
| `createTestHarness`   | No      | Yes    | Yes      |
| Actor + `yieldFibers` | Yes     | Yes    | No       |

Use `Layer.merge(ActorSystemDefault, TestContext.TestContext)` for TestClock.

## ActorRef API

| Method         | Effect | Sync | Purpose                           |
| -------------- | ------ | ---- | --------------------------------- |
| `snapshot`     | ✓      | -    | Get current state                 |
| `snapshotSync` | -      | ✓    | Get current state (sync)          |
| `matches`      | ✓      | -    | Check state tag                   |
| `matchesSync`  | -      | ✓    | Check state tag (sync)            |
| `can`          | ✓      | -    | Check if event handled (w/guards) |
| `canSync`      | -      | ✓    | Check if event handled (sync)     |
| `changes`      | Stream | -    | Stream of state updates           |
| `subscribe`    | -      | ✓    | Sync callback, returns unsub fn   |
