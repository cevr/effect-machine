# Code Tour: effect-machine

Type-safe state machines for Effect. XState-inspired API with Effect's composable patterns.

## Quick Navigation

**What are you looking for?**

```
Start here
    │
    ├─ "How do I define a machine?" ──────────► Tour 1: Core Concepts
    │
    ├─ "How do transitions/guards work?" ─────► Tour 2: Building Machines
    │
    ├─ "How does the event loop work?" ───────► Tour 3: Runtime
    │
    └─ "How do I persist/test/debug?" ────────► Tour 4: Advanced Features
```

## Tour Index

| Tour | Focus             | Key Files                                 | Start At                        |
| ---- | ----------------- | ----------------------------------------- | ------------------------------- |
| 1    | Core Concepts     | machine.ts, actor-ref.ts, actor-system.ts | `src/machine.ts:53`             |
| 2    | Building Machines | combinators/\*.ts                         | `src/combinators/on.ts:30`      |
| 3    | Runtime           | internal/loop.ts                          | `src/internal/loop.ts:193`      |
| 4    | Advanced          | persistence/, inspection.ts, testing.ts   | `src/persistence/adapter.ts:29` |

---

## Tour 1: Core Concepts

**Key insight:** Machine = data definition, ActorRef = runtime handle, ActorSystem = lifecycle manager

### Stop 1: Machine Definition

`src/machine.ts:53-60`

```ts
export interface Machine<State, Event, R = never> {
  readonly initial: State;
  readonly transitions: ReadonlyArray<Transition<State, Event, R>>;
  readonly alwaysTransitions: ReadonlyArray<AlwaysTransition<State, R>>;
  readonly onEnter: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly onExit: ReadonlyArray<StateEffect<State, Event, R>>;
  readonly finalStates: ReadonlySet<string>;
}
```

Machine is pure data. No runtime. Contains:

- Initial state
- Transitions (state + event → new state)
- Always transitions (eventless, auto-fire)
- Entry/exit effects
- Final states (terminators)

### Stop 2: Machine Creation

`src/machine.ts:65-78`

`Machine.make()` creates a machine with initial state. Combinators (`on`, `final`, etc.) add transitions via internal helpers.

All combinators are pipeable - they take and return `Machine`, so they work with `.pipe()`.

### Stop 3: ActorRef Interface

`src/actor-ref.ts:6-67`

Runtime handle to a spawned machine:

| Method                              | Purpose                            |
| ----------------------------------- | ---------------------------------- |
| `send(event)`                       | Send event to actor                |
| `state`                             | SubscriptionRef for reactive state |
| `snapshot` / `snapshotSync`         | Get current state                  |
| `matches(tag)` / `matchesSync(tag)` | Check state tag                    |
| `can(event)` / `canSync(event)`     | Check if event handled             |
| `changes`                           | Stream of state changes            |
| `subscribe(fn)`                     | Sync callback subscription         |
| `stop`                              | Graceful shutdown                  |

### Stop 4: ActorSystem

`src/actor-system.ts:20-94`

Lifecycle manager. Tracks all actors by ID.

| Method                           | Purpose                   |
| -------------------------------- | ------------------------- |
| `spawn(id, machine)`             | Create and start actor    |
| `restore(id, persistentMachine)` | Restore from persistence  |
| `get(id)`                        | Lookup existing actor     |
| `stop(id)`                       | Stop and unregister actor |

Implementation at line 104 uses `SynchronizedRef<Map>` for thread-safe actor registry.

### Stop 5: Type System

`src/internal/types.ts`

Supporting types:

- `TransitionContext<S, E>` (line 37): `{ state, event }` for handlers
- `StateEffectContext<S, E>` (line 45): `{ state, self }` for entry/exit
- `Guard<S, E>` (line 88): Composable guard with `and`/`or`/`not`

---

## Tour 2: Building Machines

**Key insight:** Combinators compose via `pipe`. Guards evaluated in registration order; first pass wins.

### Flow

```
Machine.make(initial)
    │
    ├─► on(State, Event, handler)      // event transitions
    ├─► on.force(State, Event, handler) // force reenter
    ├─► always(State, handler)          // eventless transitions
    ├─► choose(State, Event, branches)  // conditional routing
    │
    ├─► assign(State, Event, updater)   // context updates
    │
    ├─► delay(State, duration, event)   // timed events
    ├─► invoke(State, effect, events)   // async effects
    │
    ├─► onEnter(State, effect)          // entry effects
    ├─► onExit(State, effect)           // exit effects
    │
    └─► final(State)                    // terminal state
```

### Stop 1: on - Event Transitions

`src/combinators/on.ts:30-68`

Core combinator. Maps (state, event) → new state.

```ts
on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url }));
```

Options: `guard`, `effect`, `reenter`

`on.force()` (line 93) sets `reenter: true` — runs exit/enter even for same-tag transitions.

### Stop 2: final - Terminal States

`src/combinators/final.ts`

Marks state as final. Event loop stops when reached.

### Stop 3: always - Eventless Transitions

`src/combinators/always.ts`

Auto-fires when entering a state. No event needed.

```ts
always(State.Validating, ({ state }) => (state.isValid ? State.Ready({}) : State.Invalid({})));
```

With guard: only fires if guard passes.

### Stop 4: choose - Conditional Routing

`src/combinators/choose.ts`

Multiple branches with guards. First matching guard wins.

```ts
choose(State.Processing, Event.Complete, [
  { guard: ({ state }) => state.hasError, to: () => State.Error({}) },
  { to: () => State.Success({}) }, // fallback
]);
```

### Stop 5: assign - Context Updates

`src/combinators/assign.ts`

Updates state properties without changing tag.

```ts
assign(State.Counter, Event.Increment, ({ state }) => ({
  count: state.count + 1,
}));
```

### Stop 6: delay - Timed Events

`src/combinators/delay.ts`

Schedules event after duration when entering state.

```ts
delay(State.Polling, "5 seconds", Event.Poll());
```

Requires `Effect.scoped` + `ActorSystemDefault` layer.

### Stop 7: invoke - Async Effects

`src/combinators/invoke.ts`

Runs effect on state entry. Maps success/error to events.

```ts
invoke(State.Loading, ({ state }) => fetchData(state.url), {
  onDone: Event.Success,
  onError: Event.Failure,
});
```

### Stop 8-9: onEnter / onExit

`src/combinators/on-enter.ts`, `src/combinators/on-exit.ts`

Side effects on state entry/exit.

```ts
onEnter(State.Active, ({ self }) =>
  Effect.gen(function* () {
    yield* startPolling(self.send);
  }),
);
```

---

## Tour 3: Runtime Deep Dive

**Key insight:** Event loop blocks on queue, evaluates guards in registration order, applies always transitions after each state change.

### Stop 1: createActor

`src/internal/loop.ts:193-285`

Actor creation flow:

1. Get optional inspector from context (line 206)
2. Apply always transitions to initial state (line 211)
3. Create SubscriptionRef + event Queue (lines 227-228)
4. Run initial entry effects (line 237)
5. Check if already final (line 240)
6. Fork event loop fiber (line 260)
7. Return ActorRef with stop handler

### Stop 2: eventLoop

`src/internal/loop.ts:290-319`

Main loop:

```ts
while (true) {
  const event = yield* Queue.take(eventQueue); // blocks
  const shouldStop = yield* processEvent(...);
  if (shouldStop) return;
}
```

Blocks on `Queue.take`. Shutdown via `Queue.shutdown`.

### Stop 3: processEvent

`src/internal/loop.ts:324-439`

Event processing:

1. Emit inspection event (line 336)
2. Find transition via `resolveTransition` (line 347)
3. Compute new state (line 358)
4. Run transition effect if any (line 362)
5. Determine lifecycle: `stateTagChanged || reenter` (line 382)
6. If lifecycle: exit → always → update → enter (lines 386-417)
7. Check final state (line 420)

### Stop 4: resolveTransition

`src/internal/loop.ts:30-75`

Guard cascade:

```ts
for (const transition of machine.transitions) {
  if (transition.stateTag !== currentState._tag) continue;
  if (transition.eventTag !== event._tag) continue;
  if (!transition.guard) return transition; // no guard = match
  if (transition.guard({ state, event })) return transition;
  // guard failed, try next
}
```

First guard that passes wins. No guard = always matches.

### Stop 5: applyAlways

`src/internal/loop.ts:105-142`

Applies eventless transitions recursively:

- Max 100 iterations (infinite loop protection)
- Stops if no transition matches or state unchanged

---

## Tour 4: Advanced Features

### Persistence

**Files:**
| File | Purpose |
|------|---------|
| `src/persistence/adapter.ts` | Interface + error types |
| `src/persistence/persistent-machine.ts` | Machine wrapper with schemas |
| `src/persistence/persistent-actor.ts` | Actor with persist/version |
| `src/persistence/adapters/in-memory.ts` | Reference implementation |

**Flow:**

```
PersistenceAdapter (interface)
    │
    ├─► saveSnapshot / loadSnapshot
    ├─► appendEvent / loadEvents
    └─► deleteActor
```

`PersistentMachine` wraps regular machine with state/event schemas for serialization.

`PersistentActorRef` extends ActorRef with:

- `persist: Effect<void>` — save current state
- `version: Effect<number>` — current version

### Inspection

`src/inspection.ts`

Events emitted during execution:

- `@machine.spawn` — actor created
- `@machine.event` — event received
- `@machine.guard` — guard evaluated
- `@machine.transition` — state changed
- `@machine.effect` — effect ran
- `@machine.stop` — actor stopped

Usage:

```ts
const inspector = consoleInspector<State, Event>();
Effect.provideService(Inspector, inspector);
```

### Testing

`src/testing.ts`

| Function                                   | Purpose               |
| ------------------------------------------ | --------------------- |
| `simulate(machine, events)`                | Pure state traversal  |
| `assertReaches(machine, events, tag)`      | Assert final state    |
| `assertPath(machine, events, tags)`        | Assert exact path     |
| `assertNeverReaches(machine, events, tag)` | Assert avoidance      |
| `createTestHarness(machine)`               | Step-by-step control  |
| `yieldFibers`                              | Let async effects run |

`simulate` and `createTestHarness` are pure — no onEnter/onExit effects.

For full actor testing, use `yieldFibers` after `send()` to allow forked effects to execute.

---

## Gotchas

| Issue                      | Solution                                                   |
| -------------------------- | ---------------------------------------------------------- |
| Guards not working         | Check registration order — first pass wins                 |
| Infinite always loop       | Max 100 iterations; ensure transitions change state        |
| delay not firing           | Need `Effect.scoped` + `ActorSystemDefault` layer          |
| TestClock issues           | `Layer.merge(ActorSystemDefault, TestContext.TestContext)` |
| simulate skips effects     | Use real actor for entry/exit effect testing               |
| Actor test race conditions | Call `yieldFibers` after `send()`                          |
| Same-state no exit/enter   | Use `on.force()` to run lifecycle                          |
| Dynamic delay timing       | Duration evaluated at state entry, not registration        |
