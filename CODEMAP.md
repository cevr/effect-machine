# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── machine.ts            # Machine class + namespace (fluent builder)
├── schema.ts             # Schema-first State/Event factories
├── slot.ts               # Slot.Guards/Slot.Effects factories
├── actor.ts              # ActorRef + ActorSystem + event loop
├── testing.ts            # simulate, harness, assertions
├── inspection.ts         # Inspector service
├── errors.ts             # TaggedError classes
├── persistence/
│   ├── adapter.ts        # PersistenceAdapter interface
│   ├── persistent-machine.ts  # Machine.persist
│   ├── persistent-actor.ts    # PersistentActorRef
│   └── adapters/
│       └── in-memory.ts  # InMemoryPersistenceAdapter
├── cluster/
│   ├── to-entity.ts      # toEntity - Entity from machine
│   └── entity-machine.ts # EntityMachine.layer
└── internal/
    ├── transition.ts     # Transition execution + O(1) index
    ├── brands.ts         # StateBrand/EventBrand types
    └── utils.ts          # isEffect, getTag, constants

test/
├── actor.test.ts         # ActorRef + ActorSystem tests
├── machine.test.ts       # Machine builder tests
├── schema.test.ts        # State/Event schema tests
├── slot.test.ts          # Guard/Effect slot tests
├── testing.test.ts       # Test utility tests
├── inspection.test.ts    # Inspector tests
├── persistence.test.ts   # Persistence tests
├── same-state.test.ts    # Same-state transition tests
├── choose.test.ts        # Conditional transition tests
├── delay.test.ts         # Timeout patterns
├── dynamic-delay.test.ts # Dynamic timeout patterns
├── force.test.ts         # Reenter transition tests
├── utils/
│   └── effect-test.ts    # Test helpers
├── internal/
│   └── transition.test.ts # Transition index tests
├── patterns/             # Real-world patterns
│   ├── payment-flow.test.ts
│   ├── session-lifecycle.test.ts
│   ├── keyboard-input.test.ts
│   └── menu-navigation.test.ts
└── integration/
    └── cluster.test.ts   # @effect/cluster integration
```

## Key Files

| File                     | Purpose                                              |
| ------------------------ | ---------------------------------------------------- |
| `machine.ts`             | Machine class - fluent builder, all methods          |
| `schema.ts`              | `State`/`Event` factories - schema-first definitions |
| `slot.ts`                | `Slot.Guards`/`Slot.Effects` - parameterized slots   |
| `actor.ts`               | ActorRef interface, ActorSystem service, event loop  |
| `internal/transition.ts` | Transition execution, O(1) lookup index              |

## Event Flow

```
Event → resolveTransition → handler (guards/effects) → update state → spawn effects
```

- Handler receives `{ state, event, guards, effects }`
- Guards checked inside handler: `yield* guards.xxx(params)`
- Same-state transitions skip spawn/finalizers by default
- `.reenter()` forces lifecycle even for same state tag

## Machine Architecture

Mutable builder with immutable public views:

```ts
// Internal mutable
readonly _transitions: Array<Transition>;

// Public readonly
get transitions(): ReadonlyArray<Transition>
```

- Builder methods mutate `this`, return `this` for chaining
- Exception: `provide()` creates new instance (reusable base)
- Phantom types constrain state/event to schema variants

## Transition Index

`internal/transition.ts` - O(1) lookup via WeakMap cache:

- `findTransitions(machine, stateTag, eventTag)`
- `findSpawnEffects(machine, stateTag)`
- Index built on first access, cached per machine

## Testing Matrix

| Function            | Runs Slots | Runs Spawn | Use For         |
| ------------------- | ---------- | ---------- | --------------- |
| `simulate`          | Yes        | No         | Path assertions |
| `createTestHarness` | Yes        | No         | Step-by-step    |
| Actor + yieldNow    | Yes        | Yes        | Integration     |

Use `TestContext.TestContext` for TestClock in spawn tests.
