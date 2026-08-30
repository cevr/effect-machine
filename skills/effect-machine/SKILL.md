---
name: effect-machine
description: Type-safe state machines for Effect. Use when defining schema-first state and events, Effectful transitions, tasks, actors, typed input and output, Atom selectors, inspection, recovery, durability, supervision, or cluster entities with effect-machine.
---

## Navigation

```
What are you building?
├─ Defining states/events           → §Schema-First
├─ Writing transition handlers      → §Transitions
├─ Adding side effects              → §Effects
├─ Composing input and output       → §Input and Output
├─ Connecting a UI                  → §Effect Atom
├─ Testing machines                 → §Testing
├─ Running actors                   → §Actors
├─ Typed ask/reply                  → §Ask / Reply
├─ Recovery/durability              → §Lifecycle
└─ Timeouts / postpone              → §Timeouts, §Postpone
```

## Schema-First

States and events ARE schemas. `State({})` and `Event({})` produce tagged unions with constructors.

```ts
import { Schema } from "effect";
import { State, Event } from "effect-machine";

const S = State({
  Idle: {}, // empty → plain value: S.Idle
  Loading: { url: Schema.String }, // non-empty → constructor: S.Loading({ url })
});

const E = Event({
  Start: { url: Schema.String },
  Done: { data: Schema.Unknown },
  GetCount: Event.reply({}, Schema.Number), // reply-bearing event
  GetInfo: Event.reply({ id: Schema.String }, Schema.String), // payload + reply
});
```

**`.with()`** — construct from existing state and copy overlapping fields:

```ts
S.Active.with(state); // pick target fields from source
S.Active.with(state, { count: n + 1 }); // pick + override
```

**Type guards / matching:**

```ts
S.$is("Loading")(value)                  // boolean type guard
S.$match(value, { Loading: (s) => ..., _: () => ... })  // pattern match
```

## Transitions

```ts
const machine = Machine.make({ state: S, event: E, initial: S.Idle })
  // Single state → event → handler
  .on(S.Idle, E.Start, ({ event }) => S.Loading({ url: event.url }))

  // Multi-state source
  .on([S.Loading, S.Retrying], E.Done, ({ event }) => S.Active({ data: event.data }))

  // Wildcard — any state (specific .on wins)
  .onAny(E.Cancel, () => S.Cancelled)

  // Reenter same state (re-triggers spawn effects + timeouts)
  .reenter(S.Active, E.Refresh, ({ state }) => S.Active.with(state))

  // Mark final states (actor stops, postpone buffer settles)
  .final(S.Done)
  .final(S.Cancelled);
```

Register repeated candidates for guarded edges. The first passing guard wins. An unguarded candidate is the fallback. `actor.can(event)` evaluates the same guards.

```ts
machine
  .when(
    S.Checking,
    E.Continue,
    ({ state }) => state.stock > 0,
    () => S.Accepted,
  )
  .on(S.Checking, E.Continue, () => S.Rejected)
  .immediate(S.Accepted, ({ state }) => S.Ready.with(state));
```

The `.when()` predicate can return a Boolean or `Effect<boolean, never, R>`. Predicate requirements flow into the machine type. Use `actor.can(event)` inside Effect. Use `actor.client.can(event)` outside Effect. Use `actor.client.canSync(event)` only when the candidate predicates are synchronous.

Immediate transitions settle before subscribers see state.

**Handler return types:**

```ts
// Pure: return new state
({ state, event }) => S.Next({ ... })

// Effectful: return Effect<State>
({ state }) => Effect.gen(function* () { ... return S.Next({ ... }) })

// With reply (for actor.ask — event must use Event.reply()):
({ state }) => Machine.reply(S.Same.with(state), state.count)
```

## Effects

### spawn — state-scoped, auto-cancelled on exit

```ts
machine.spawn(S.Loading, ({ state, self }) =>
  Effect.gen(function* () {
    const data = yield* fetchData(state.url);
    yield* self.send(E.Done({ data }));
  }),
);
```

### task — spawn + auto-route success/failure

```ts
machine.task(S.Loading, ({ state }) => fetchData(state.url), {
  onSuccess: (data) => E.Done({ data }),
  onFailure: (_error) => E.Error,
});
```

`onFailure` receives only the typed Effect error. A defect stops the actor or starts supervision.

### background — machine-lifetime (not state-scoped)

```ts
machine.background(({ self }) =>
  Stream.fromSchedule(Schedule.spaced("10 seconds")).pipe(
    Stream.runForEach(() => self.send(E.Heartbeat)),
  ),
);
```

## Effect Services

Task, spawn, background, and Effectful transition handlers can use standard Effect services:

```ts
class Notifier extends Context.Service<
  Notifier,
  { readonly notify: (message: string) => Effect.Effect<void> }
>()("app/Notifier") {}

const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Done, ({ state }) =>
  Effect.flatMap(Notifier, (notifier) => notifier.notify(`Done: ${state.id}`)),
);

const actor =
  yield * Machine.spawn(machine).pipe(Effect.provideService(Notifier, { notify: Effect.log }));
yield * actor.start;
```

`Machine.spawn` captures the current Effect context. A later `actor.start` keeps those services. All handler requirements remain in the machine type until the caller provides them.

The `.when()` predicate can return a Boolean or an Effect that returns a Boolean. A transition handler can return a state or an Effect that returns a state. Both error channels must be `never`.

## Input and Output

```ts
const machine = Machine.make({
  state: S,
  event: E,
  initial: (input: { readonly id: string }) => S.Loading(input),
}).final(S.Done, ({ state }) => state.value);

const output = yield * Machine.run(machine, { input: { id: "item-1" } });
```

- Input creates initial state. It does not replace Effect context.
- Output is separate from the retained final state.
- `Machine.run` starts, awaits output, and always stops one autonomous actor.
- Compose autonomous runs with `Effect.flatMap` or `Effect.gen`.
- Use a parent machine for an interactive multi-phase UI.
- Do not add an action queue. Use Effect handlers.

## Ask / Reply

Events declare reply schemas via `Event.reply(fields, schema)`. Handlers must use `Machine.reply()`:

```ts
const E = Event({
  GetCount: Event.reply({}, Schema.Number), // askable
  Reset: {}, // not askable
});

// Handler — Machine.reply() required for reply-bearing events
machine.on(S.Active, E.GetCount, ({ state }) => Machine.reply(S.Active.with(state), state.count));

// Caller — return type inferred from schema
const count = yield * actor.ask(E.GetCount); // number
// actor.ask(E.Reset) — TYPE ERROR (no reply schema)
```

**Rules:**

- `Event.reply({}, schema)` — empty payload + reply; `Event.reply({ id: Schema.String }, schema)` — payload + reply
- Handler for reply-bearing event MUST return `Machine.reply(state, value)` — plain state return is a type error
- Handler for non-reply event CANNOT return `Machine.reply()` — type error
- `.onAny()` handlers cannot provide replies — use specific `.on()` for reply events
- Reply decode mismatch (handler returns wrong type) = defect at runtime
- Cluster: `Ask` RPC propagates replies through entity boundary

## Timeouts

gen_statem-style. Timer starts on state entry, cancels on exit:

```ts
machine.timeout(S.Loading, {
  duration: Duration.seconds(30),
  event: E.Timeout,
});

// Dynamic duration from state
machine.timeout(S.Retrying, {
  duration: (state) => Duration.seconds(state.backoff),
  event: E.GiveUp,
});
```

`.reenter()` restarts the timer with fresh state values.

## Postpone

gen_statem-style. Buffered events drain FIFO on state change, looping until stable:

```ts
machine.postpone(S.Connecting, E.Data).postpone(S.Connecting, [E.Data, E.Command]);
```

Multi-stage: if a drained event causes another state change, postponed events re-drain.

## Actors

### Machine.spawn — standalone, unstarted actor

`Machine.spawn` returns a **cold** actor. Call `actor.start` to fork the event loop. Events sent before `start()` are queued.

```ts
const actor = yield * Machine.spawn(machine);
yield * actor.start;

// With options
const actor = yield * Machine.spawn(machine, { id: "my-id", hydrate: savedState });
yield * actor.start;
```

Call `actor.stop` when you manage the actor lifetime. Use `Machine.scoped(effect)` to bridge
`Scope.Scope` to `ActorScope` and attach automatic cleanup. Ambient `Scope.Scope` does not attach cleanup.

### ActorRef API

| Method                 | Description                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| `start`                | Fork event loop + effects (required after `Machine.spawn`)          |
| `send(event)`          | Fire-and-forget                                                     |
| `call(event)`          | Request-reply → `ProcessEventResult`                                |
| `ask(event)`           | Typed reply (event must have `Event.reply()` schema)                |
| `snapshot`             | Current state                                                       |
| `changes`              | `Stream<State>` (SubscriptionRef-backed)                            |
| `transitions`          | `Stream<{ fromState, toState, event }>` (PubSub-backed edge stream) |
| `waitFor(S.X)`         | Wait for state                                                      |
| `sendAndWait(ev, S.X)` | Send + wait                                                         |
| `awaitFinal`           | Wait for final state                                                |
| `awaitOutput`          | Wait for typed machine output                                       |
| `awaitExit`            | Wait for terminal exit                                              |
| `sync.*`               | Sync variants for non-Effect boundaries                             |

### ActorSystem — registry + lifecycle (auto-starts)

`system.spawn` auto-starts — no `actor.start` needed.

```ts
const system = yield * ActorSystemService;
const actor = yield * system.spawn("id", machine); // auto-started
const maybe = yield * system.get("id"); // Option<ActorRef>
yield * system.stop("id"); // boolean
system.actors; // ReadonlyMap snapshot
system.events; // Stream<SystemEvent>
```

### Child actors

```ts
machine.spawn(S.Active, ({ self }) =>
  Effect.gen(function* () {
    const child = yield* self.spawn("worker", workerMachine).pipe(Effect.orDie);
    yield* child.send(WorkerEvent.Start);
    // auto-stopped when parent exits Active
  }),
);
```

## Lifecycle

Recovery + Durability hooks for persistence. Passed via `lifecycle` option on `Machine.spawn` / `system.spawn`.

```ts
const actor =
  yield *
  Machine.spawn(machine, {
    lifecycle: {
      recovery: {
        // Runs during actor.start. Return Some to override initial state, None for cold start.
        resolve: ({ actorId, generation, machineInitial }) =>
          storage.get(actorId).pipe(Effect.map(Option.fromNullable)),
      },
      durability: {
        // Runs after each committed transition
        save: ({ actorId, generation, previousState, nextState, event }) =>
          storage.set(actorId, nextState),
        // Optional sync filter — skip uninteresting transitions
        shouldSave: (state, prev) => state._tag !== prev._tag,
      },
    },
  });
yield * actor.start;
```

| Interface          | When it runs                                     | Receives                                                   |
| ------------------ | ------------------------------------------------ | ---------------------------------------------------------- |
| `Recovery<S>`      | During `actor.start` (and supervision restart)   | `{ actorId, generation, machineInitial }`                  |
| `Durability<S, E>` | After each state commit, before reply settlement | `{ actorId, generation, previousState, nextState, event }` |

- `generation` — 0 = cold start, 1+ = supervision restart
- `hydrate` overrides recovery — `Machine.spawn(machine, { hydrate: state })` skips `resolve` entirely
- `Lifecycle<S, E>` = `{ recovery?, durability? }` — both optional

### Replay + Hydrate

```ts
// Restore from snapshot
const actor = yield * Machine.spawn(machine, { hydrate: loadedState });
yield * actor.start;

// Restore from event log
const state = yield * Machine.replay(machine, events);
const actor = yield * Machine.spawn(machine, { hydrate: state });
yield * actor.start;

// Restore from snapshot + tail events
const state = yield * Machine.replay(machine, tailEvents, { from: snapshot });
const actor = yield * Machine.spawn(machine, { hydrate: state });
yield * actor.start;
```

**Machine.replay semantics:**

- Folds events through transition handlers (pure or effectful)
- `self.send`/`self.spawn` are no-ops (stubbed)
- Spawn effects, background effects, timeouts do NOT run
- Postpone rules respected (loop until stable)
- Final state stops replay
- Unhandled events silently skipped

## Testing

```ts
import { simulate, assertPath, assertReaches, createTestHarness } from "effect-machine";

// Simulate — run events, get all states
const { states, finalState } = yield * simulate(machine, [E.Start, E.Done]);

// Assertions
yield * assertPath(machine, events, ["Idle", "Loading", "Done"]);
yield * assertReaches(machine, events, "Done");
yield * assertNeverReaches(machine, events, "Error");

// Test harness — step-by-step
const harness = yield * createTestHarness(machine);
yield * harness.send(E.Start);
expect(harness.state._tag).toBe("Loading");
```

Both `simulate` and `createTestHarness` accept `Machine` directly.

## Effect Atom

```ts
import * as ActorAtom from "effect-machine/atom";

const stateAtom = ActorAtom.make(actor);
const countAtom = ActorAtom.select(stateAtom, (state) => state.count);
const lifecycleAtom = ActorAtom.lifecycle(actor);
const transitionAtom = ActorAtom.latestTransition(actor);
const canStartAtom = ActorAtom.can(actor, E.Start);
```

The actor owns state. Atom writes send events. Selected Atoms publish only when their selected value changes. Capability Atoms publish only when the Boolean answer changes. React uses `useAtomSuspense`. Solid uses `useAtomResource` inside Suspense. Keep exit-animation data in the next or final machine state.

## Inspection

Provide `InspectorService` when the actor is allocated. Inspection reports actor spawn, event receipt, named guard results, named transition operations, transitions, state-owned Effects, task phases, defects, actor stop, and actor generation.

Use `consoleInspector()` for Effect logs, `tracingInspector()` for traces, and `collectingInspector(events)` for tests.

## Gotchas

- **`Machine.spawn` returns unstarted actor** — must call `yield* actor.start`. `system.spawn` auto-starts.
- **Services are provided through Effect** — provide them when `Machine.spawn` allocates the actor
- **Empty state = value, non-empty = constructor** — `S.Idle` vs `S.Loading({ url })`
- **Spawn effects re-run on hydrate** — `Machine.spawn({ hydrate })` re-runs spawn effects for the hydrated state (timers, scoped resources)
- **`hydrate` overrides recovery** — `resolve()` is never called when `hydrate` is set
- **`transitions` is observational** — PubSub-backed, late subscribers miss edges. Not a durability guarantee.
- **Effectful handlers in replay** — replay runs handlers but stubs `self`/`system`. Side effects through `self.send` are no-ops.
- **`ask()` requires reply schema** — only events with `Event.reply()` accepted; non-reply events are type errors
- **Reply decode failure = defect** — if handler returns wrong type, actor dies (broken handler, not business logic)
- **Effectful transition errors are `never`** — convert expected failures to states or events
- **No machine action API** — use transitions, tasks, scoped Effects, and Effect composition
- **Examples** — use the runnable workspace under `examples/`
