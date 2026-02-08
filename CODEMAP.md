# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── machine.ts            # Machine class + namespace (fluent builder)
├── schema.ts             # Schema-first State/Event factories + derive
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
    ├── transition.ts     # Transition execution + O(1) index + wildcard fallback
    ├── brands.ts         # StateBrand/EventBrand types
    └── utils.ts          # isEffect, getTag, constants, stubSystem

test/
├── actor.test.ts         # ActorRef, ActorSystem, waitFor, sendSync, deadlock regression
├── child-actor.test.ts   # Child actors: self.spawn, lifecycle coupling, implicit system
├── machine.test.ts       # Machine builder, multi-state .on(), .onAny(), .build()
├── schema.test.ts        # State/Event schema, derive, pattern matching
├── slot.test.ts          # Guard/Effect slot tests
├── reenter.test.ts       # Reenter transitions, derive usage
├── testing.test.ts       # Test utility tests
├── inspection.test.ts    # Inspector tests
├── persistence.test.ts   # Persistence tests
├── conditional-transitions.test.ts  # Guard-based conditional transitions
├── timeouts.task.test.ts # Timeout/task patterns
├── type-constraints.test.ts # Compile-time type constraint verification
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

| File                     | Purpose                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `machine.ts`             | Machine class, fluent builder, `Machine.spawn`, `.on()`/`.onAny()`/`.build()` → `BuiltMachine` |
| `schema.ts`              | `State`/`Event` factories, `derive()`, `$is`/`$match`                                          |
| `slot.ts`                | `Slot.Guards`/`Slot.Effects` - parameterized slots                                             |
| `actor.ts`               | ActorRef (`waitFor`, `sendSync`, `sendAndWait`), ActorSystem, createActor, implicit system     |
| `internal/transition.ts` | Transition execution, O(1) lookup index, wildcard `"*"` fallback                               |

## Event Flow

```
Event → resolveTransition → handler (guards/effects) → update state → spawn effects
          ↓ no specific match
        wildcard "*" fallback (.onAny transitions)
```

- Handler receives `{ state, event, guards, effects, system }`
- `.spawn()`/`.background()` handlers also get `self` (with `self.spawn(id, machine)` for child actors)
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
- `.build()` is terminal — returns `BuiltMachine`, no further chaining
- No-slot machines: `.build()` with no args
- Phantom types constrain state/event to schema variants
- `.on()` accepts single state or `ReadonlyArray` of states
- `.onAny()` stores transition with `stateTag: "*"` sentinel

## Transition Index

`internal/transition.ts` - O(1) lookup via WeakMap cache:

- `findTransitions(machine, stateTag, eventTag)` — specific match first, `"*"` wildcard fallback
- `findSpawnEffects(machine, stateTag)`
- `runTransitionHandler` - shared handler execution (used by actor, testing, persistence)
- Index built on first access, cached per machine, invalidated on mutation

## State.derive()

`schema.ts` — `derive` attached to each variant constructor/value:

- Reads `_definition` to know target field names
- Picks matching fields from source object
- Applies partial overrides (overrides win over source)
- Empty variants return `{ _tag }` regardless of source

## waitFor / sendAndWait

`actor.ts` — deadlock-free via sync listeners + Deferred:

- `SubscriptionRef.get` for initial snapshot (quick semaphore acquire/release)
- Sync listener callback (no semaphore held) + `Deferred.await` for future changes
- Re-checks after subscribing to close race window
- Accepts state constructor (`State.Active`) or predicate function

## Actor Registry

`actor.ts` uses `MutableHashMap` for O(1) spawn/stop/get operations.

## Implicit System

`createActor` detects `ActorSystem` in context via `Effect.serviceOption`:

- **Found**: reuses it (system-spawned actors, children inheriting parent's system)
- **Not found**: creates scoped implicit system (torn down on `actor.stop`)

All descendants share the same system through Effect service context (daemon fibers inherit environment).

## Shared Context

All machines share single `MachineContextTag` from `slot.ts` - no per-machine allocation.

## Testing Matrix

| Function            | Runs Slots | Runs Spawn | Use For         |
| ------------------- | ---------- | ---------- | --------------- |
| `simulate`          | Yes        | No         | Path assertions |
| `createTestHarness` | Yes        | No         | Step-by-step    |
| Actor + yieldNow    | Yes        | Yes        | Integration     |

Use `TestContext.TestContext` for TestClock in spawn tests.
