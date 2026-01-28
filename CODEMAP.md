# Codemap

## Structure

```
src/
├── index.ts              # Public exports
├── namespace.ts          # Machine namespace (Effect-style API)
├── machine-schema.ts     # Schema-first State/Event (MachineStateSchema, MachineEventSchema)
├── machine.ts            # Machine class with fluent builder API
├── slot.ts               # Slot.Guards/Slot.Effects factories for parameterized slots
├── actor-ref.ts          # Actor reference interface
├── actor-system.ts       # Actor system service + layer
├── testing.ts            # Test utilities (simulate, harness, assertions)
├── inspection.ts         # Inspector service for debugging
├── errors.ts             # TaggedError classes
├── persistence/
│   ├── adapter.ts        # PersistenceAdapter interface + tags
│   ├── persistent-machine.ts  # Machine.persist combinator
│   ├── persistent-actor.ts    # PersistentActorRef implementation
│   └── in-memory.ts      # InMemoryPersistenceAdapter
├── cluster/
│   ├── index.ts          # Cluster exports
│   └── entity-machine.ts # toEntity - generates Entity from machine
└── internal/
    ├── loop.ts              # Event loop, transition resolver, lifecycle effects
    ├── execute-transition.ts # Shared transition execution (loop, simulate, harness)
    ├── transition-index.ts  # O(1) lookup for transitions
    ├── fiber-storage.ts     # Per-actor WeakMap fiber storage utility
    ├── brands.ts            # StateBrand/EventBrand + BrandedState/BrandedEvent
    ├── types.ts             # Internal utility types
    ├── is-effect.ts         # Shared isEffect type guard
    └── get-tag.ts           # Tag extraction from constructors

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
│   ├── any.test.ts
│   ├── delay.test.ts         # Timeout via spawn patterns
│   ├── dynamic-delay.test.ts # Dynamic timeout via spawn
│   ├── effects.test.ts
│   ├── force.test.ts         # reenter transition tests
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

| File                                | Purpose                                                     |
| ----------------------------------- | ----------------------------------------------------------- |
| `machine.ts`                        | Machine class - fluent builder, all combinators as methods  |
| `machine-schema.ts`                 | Schema-first `State`/`Event` - single source of truth       |
| `slot.ts`                           | `Slot.Guards`/`Slot.Effects` - parameterized slot factories |
| `namespace.ts`                      | Machine namespace export (named for macOS compat)           |
| `internal/loop.ts`                  | Event processing, `resolveTransition`, spawn effect forking |
| `internal/transition-index.ts`      | O(1) lookup for transitions                                 |
| `internal/brands.ts`                | Branded types: `StateBrand`, `BrandedState`, etc.           |
| `internal/fiber-storage.ts`         | `createFiberStorage()` - per-actor WeakMap utility          |
| `persistence/persistent-machine.ts` | `Machine.persist` - schemas from machine                    |
| `cluster/entity-machine.ts`         | `toEntity` - schemas from machine                           |

## Machine Class Architecture

Machine uses mutable builder pattern with immutable public views:

```ts
// Internal mutable arrays
readonly _transitions: Array<Transition<...>>;
readonly _guardHandlers: Map<string, GuardHandler>;
readonly _effectHandlers: Map<string, EffectHandler>;

// Public readonly getters
get transitions(): ReadonlyArray<Transition<...>> { return this._transitions; }
```

- Builder methods mutate `this` and return `this` for chaining
- Exception: `provide()` creates new Machine (supports reusing base with different handlers)
- Phantom types `_SD`/`_ED` constrain state/event to schema variants at compile time
- `GD`/`EFD` type params track guard/effect definitions

## Event Flow

```
Event → resolveTransition → handler (w/ guards/effects) → update state → spawn effects
```

- Handler receives `{ state, event, guards, effects }` context
- Guards checked inside handler via `yield* guards.xxx(params)`
- Same-state transitions skip spawn/finalizer by default
- `.reenter()`: force spawn/finalizer even for same state tag
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
  guards: MyGuards, // optional - Slot.Guards definition
  effects: MyEffects, // optional - Slot.Effects definition
  initial: MyState.Idle, // empty struct: no parens needed
});
```

- Types inferred from schemas - no manual type params
- Empty structs: `State.Idle` (value, not callable)
- Non-empty: `State.Loading({ url })` - args required
- `persist()` and `toEntity()` read schemas from machine - no drift possible
- `$match` and `$is` helpers for pattern matching

## Parameterized Slots Pattern

Guards and effects defined via `Slot.Guards`/`Slot.Effects`:

```ts
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number },  // with params
  isValid: {},                        // no params
});

const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
});

// Use in handlers
.on(State.Idle, Event.Start, ({ state, guards, effects }) =>
  Effect.gen(function* () {
    if (yield* guards.canRetry({ max: 3 })) {
      yield* effects.fetchData({ url: state.url });
      return State.Loading({ url: state.url });
    }
    return state;
  })
)

// Provide implementations - (params, ctx) signature
.provide({
  canRetry: ({ max }, { state }) => state.attempts < max,
  fetchData: ({ url }, { self }) =>
    Effect.gen(function* () {
      const data = yield* Http.get(url);
      yield* self.send(Event.Resolve({ data }));
    }),
})
```

- Guards return `boolean | Effect<boolean>`
- Effects return `Effect<void>`
- Context (`ctx`) has `{ state, event, self }`
- `provide()` creates new machine - original reusable with different handlers

## Fiber Storage Pattern

`spawn` uses shared utility from `internal/fiber-storage.ts`:

```ts
import { createFiberStorage } from "../internal/fiber-storage.js";

const getFiberMap = createFiberStorage(); // WeakMap-backed, per-actor
const instanceKey = Symbol("spawn"); // unique per combinator instance
getFiberMap(self).set(instanceKey, fiber);
```

## Transition Index

`internal/transition-index.ts` provides O(1) lookup via lazy-built WeakMap cache:

- `findTransitions(machine, stateTag, eventTag)` - event transitions

Index built on first access, cached per machine instance.

## spawn Pattern

Spawn and background use effect slots - same pattern as guards/effects in handlers:

```ts
const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
  heartbeat: {},
});

machine
  // Spawn calls effect slot
  .spawn(State.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  // Background calls effect slot (no name parameter)
  .background(({ effects }) => effects.heartbeat())
  .provide({
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.log("Leaving"));
        const data = yield* fetchData(url);
        yield* self.send(Event.Resolve({ data }));
      }),
    heartbeat: (_, { self }) =>
      Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(Event.Ping)))),
  });
```

- `spawn` forks into state scope - cancelled on state exit
- `background` forks into machine scope - cancelled on stop/final
- Effect implementations live in `provide()` - consistent with guards
- Use `Effect.addFinalizer` for cleanup logic
- `simulate()` ignores spawn/background effects - works without real actor

## Testing

| Function            | Guard/Effect Slots | Spawn Effects | Observer |
| ------------------- | ------------------ | ------------- | -------- |
| `simulate`          | Yes                | No            | No       |
| `createTestHarness` | Yes                | No            | Yes      |
| Actor + yieldNow    | Yes                | Yes           | No       |

Use `Layer.merge(ActorSystemDefault, TestContext.TestContext)` for TestClock.

## ActorRef API

| Method         | Effect | Sync | Purpose                         |
| -------------- | ------ | ---- | ------------------------------- |
| `snapshot`     | Yes    | -    | Get current state               |
| `snapshotSync` | -      | Yes  | Get current state (sync)        |
| `matches`      | Yes    | -    | Check state tag                 |
| `matchesSync`  | -      | Yes  | Check state tag (sync)          |
| `can`          | Yes    | -    | Check if event handled          |
| `canSync`      | -      | Yes  | Check if event handled (sync)   |
| `changes`      | Stream | -    | Stream of state updates         |
| `subscribe`    | -      | Yes  | Sync callback, returns unsub fn |
