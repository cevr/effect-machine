# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── namespace.ts          # Machine namespace (Effect-style API)
├── machine-schema.ts     # Schema-first State/Event (MachineStateSchema, MachineEventSchema)
├── machine.ts            # Machine class with fluent builder API
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── inspection.ts         # Inspector service for debugging
├── errors.ts             # TaggedError classes
├── combinators/
│   └── assign.ts         # Partial state update helper (assign function)
├── persistence/
│   ├── adapter.ts        # PersistenceAdapter interface + tags
│   ├── persistent-machine.ts  # Machine.persist combinator
│   ├── persistent-actor.ts    # PersistentActorRef implementation
│   └── in-memory.ts      # InMemoryPersistenceAdapter
├── cluster/
│   ├── index.ts          # Cluster exports
│   └── entity-machine.ts # toEntity - generates Entity from machine
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
│   ├── invoke.test.ts    # Root/parallel invokes
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

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `machine.ts`                        | Machine class - fluent builder, all combinators as methods |
| `machine-schema.ts`                 | Schema-first `State`/`Event` - single source of truth      |
| `namespace.ts`                      | Machine namespace export (named for macOS compat)          |
| `internal/loop.ts`                  | Event processing, `resolveTransition`, lifecycle effects   |
| `internal/transition-index.ts`      | O(1) lookup for transitions, always, onEnter, onExit       |
| `internal/brands.ts`                | Branded types: `StateBrand`, `BrandedState`, etc.          |
| `internal/fiber-storage.ts`         | `createFiberStorage()` - per-actor WeakMap utility         |
| `persistence/persistent-machine.ts` | `Machine.persist` - schemas from machine                   |
| `cluster/entity-machine.ts`         | `toEntity` - schemas from machine                          |

## Machine Class Architecture

Machine uses mutable builder pattern with immutable public views:

```ts
// Internal mutable arrays
readonly _transitions: Array<Transition<...>>;
readonly _effectSlots: Map<string, EffectSlot>;

// Public readonly getters
get transitions(): ReadonlyArray<Transition<...>> { return this._transitions; }
get effectSlots(): ReadonlyMap<string, EffectSlot> { return this._effectSlots; }
```

- Builder methods mutate `this` and return `this` for chaining
- Exception: `provide()` creates new Machine (supports reusing base with different effects)
- Phantom types `_SD`/`_ED` constrain state/event to schema variants at compile time

## Event Flow

```
Event → resolveTransition (guard cascade) → onExit → handler → applyAlways → onEnter → update state
```

- Guard cascade: first passing guard wins (registration order)
- Same-state transitions skip onExit/onEnter by default
- `.on.force()`: force onExit/onEnter even for same state tag
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
  initial: MyState.Idle, // empty struct: no parens needed
});
```

- Types inferred from schemas - no manual type params
- Empty structs: `State.Idle` (value, not callable)
- Non-empty: `State.Loading({ url })` - args required
- `persist()` and `toEntity()` read schemas from machine - no drift possible
- `$match` and `$is` helpers for pattern matching

## Fiber Storage Pattern

`delay` and `provide` (for invoke) use shared utility from `internal/fiber-storage.ts`:

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

```ts
machine
  .invoke(State.Loading, "fetchData")   // state-scoped invoke
  .invoke("background")                  // root-level (machine lifetime)
  .invoke(State.X, ["a", "b"])          // parallel state invokes
  .invoke(["a", "b"])                    // parallel root invokes
  .provide({ fetchData: ... })          // wires handler, returns NEW machine
```

- `provide()` creates new machine (original reusable with different handlers)
- Spawning validates all slots have handlers (runtime check)
- `simulate()` ignores effects - works with unprovided machines
- Root invokes start on spawn, interrupted on stop or final state

## Guard Pattern

Guards can be sync or async (Effect):

```ts
Guard.make(({ state }) => state.count > 0); // anonymous sync
Guard.make("canRetry", ({ state }) => state.retries < 3); // named sync
Guard.make(
  "hasPermission",
  (
    { state }, // named async
  ) =>
    Effect.gen(function* () {
      const auth = yield* AuthService;
      return yield* auth.check(state.userId);
    }),
);
```

- Async guards add R to machine type - `simulate` requires providing R
- Composition: `Guard.and`, `Guard.or`, `Guard.not`
- Inline guards in `.on()` options get narrowed types automatically

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
| `snapshot`     | Yes    | -    | Get current state                 |
| `snapshotSync` | -      | Yes  | Get current state (sync)          |
| `matches`      | Yes    | -    | Check state tag                   |
| `matchesSync`  | -      | Yes  | Check state tag (sync)            |
| `can`          | Yes    | -    | Check if event handled (w/guards) |
| `canSync`      | -      | Yes  | Check if event handled (sync)     |
| `changes`      | Stream | -    | Stream of state updates           |
| `subscribe`    | -      | Yes  | Sync callback, returns unsub fn   |
