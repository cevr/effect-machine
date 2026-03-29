# effect-machine

Type-safe state machines for Effect.

## Commands

```bash
bun run gate          # typecheck + lint + test + build
bun test              # Run tests
bun run typecheck     # TypeScript check
bun run lint          # oxlint
bun run fmt           # oxfmt
```

## Conventions

- Files: kebab-case (`actor.ts`, `persistent-actor.ts`)
- States/Events: schema-first with `State({...})` / `Event({...})` - they ARE schemas
- Empty structs: plain values - `State.Idle` (not callable)
- Non-empty: `State.Loading({ url })` - constructor requiring args
- Machine creation: `Machine.make({ state, event, initial })` - types inferred
- Exports: all public API via `src/index.ts`
- Namespace pattern: `import { Machine } from "effect-machine"` then `Machine.make`, etc.

## Fluent Builder

```ts
const machine = Machine.make({ state, event, initial })
  .on(State.Idle, Event.Start, () => State.Running)
  .on([State.Draft, State.Review], Event.Cancel, () => State.Cancelled) // multi-state
  .onAny(Event.Reset, () => State.Idle) // wildcard (any state)
  .spawn(State.Running, ({ effects }) => effects.poll())
  .timeout(State.Loading, { duration: Duration.seconds(30), event: Event.Timeout })
  .postpone(State.Connecting, Event.Data)
  .final(State.Done);
```

- Builder methods mutate `this`, return `this`
- Builder chain ends naturally — no terminal method needed
- `.onAny()` fires when no specific `.on()` matches for that event

## Slots

Guards and effects are parameterized slots. Handlers provided at spawn time:

```ts
const MyGuards = Slot.Guards({ canRetry: { max: Schema.Number } });
const MyEffects = Slot.Effects({ fetch: { url: Schema.String } });

const machine = Machine.make({ state, event, guards: MyGuards, effects: MyEffects, initial }).on(
  State.X,
  Event.Y,
  ({ guards, effects }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        yield* effects.fetch({ url: "/api" });
      }
      return State.Z;
    }),
);

// Provide slot implementations at spawn time
const actor =
  yield *
  Machine.spawn(machine, {
    slots: {
      canRetry: ({ max }, { state }) => state.attempts < max,
      fetch: ({ url }, { self }) => Http.get(url),
    },
  });
```

## Running Machines

**Simple (no registry):**

```ts
const actor = yield * Machine.spawn(machine);
yield * actor.stop; // caller responsible

// Scope-aware — auto-cleanup:
yield *
  Effect.scoped(
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      // actor.stop called automatically when scope closes
    }),
  );
```

**With registry:**

```ts
const system = yield * ActorSystemService;
const actor = yield * system.spawn("my-id", machine);
```

**Lifecycle:** `Machine.spawn` and `system.spawn` detect scope via `Effect.serviceOption` — if present, attach finalizer; if absent, skip. Forgetting `actor.stop` without a scope = permanent fiber leak.

## Supervision

Actors can automatically restart on defect with `Supervision.restart()`:

```ts
import { Supervision } from "effect-machine";

const actor =
  yield *
  Machine.spawn(machine, {
    supervision: Supervision.restart({ maxRestarts: 3, within: "1 minute" }),
  });

// Via system
const actor =
  yield *
  system.spawn("id", machine, {
    supervision: Supervision.restart(),
  });

// Observe exit reason
const exit = yield * actor.awaitExit; // ActorExit<S>
const exit = yield * actor.watch(other); // ActorExit<unknown>
```

- **Restart from `machine.initial`** — always clean slate, never last-state
- **Actor ID survives** — same identity across restarts
- **Pending requests fail** — `call`/`ask`/`sendWait` behind crash get `ActorStoppedError`
- **Children die** — both scopes close; children come back only if restart re-runs spawn/background
- **`stop`/`drain` are terminal** — no restart
- **Final state = no restart** — `awaitExit` resolves with `ActorExit.Final`
- **Budget** — `Schedule` controls timing/count; exhaustion = terminal `ActorExit.Defect`
- **Classifier** — `shouldRestart` optionally skips restart for specific defect types
- Entity-machine: cluster-supervised via `defectRetryPolicy`, NOT local supervision

## Child Actors

Spawn children from `.spawn()`/`.background()` handlers via `self.spawn(id, childMachine)`:

```ts
machine.spawn(State.Active, ({ self }) =>
  Effect.gen(function* () {
    const child = yield* self.spawn("worker-1", workerMachine).pipe(Effect.orDie);
    yield* child.send(WorkerEvent.Start);
    // child auto-stopped when parent exits Active state
  }),
);
```

- Children spawned in `.spawn()` handlers are **state-scoped** — auto-stopped on state exit
- Children spawned in `.background()` handlers live for machine lifetime
- `self.spawn` returns `Effect<ActorRef, DuplicateActorError, R>` — use `Effect.orDie` in handlers
- Every `ActorRef` has `actor.system` for child access: `actor.system.get("worker-1")`

## ActorRef API

```ts
actor.send(event); // fire-and-forget
actor.cast(event); // alias for send
actor.call(event); // request-reply, returns ProcessEventResult
actor.ask(event); // typed reply (event must have Event.reply())
actor.waitFor(State.X); // wait for state (constructor or predicate)
actor.sendAndWait(ev, X); // send + wait for state
actor.awaitFinal; // wait for final state
actor.watch(other); // completes when other actor stops
actor.drain; // process remaining queue, then stop
actor.subscribe(fn); // sync callback, returns unsubscribe
actor.system; // ActorSystem
actor.children; // ReadonlyMap<string, ActorRef>

// Sync helpers (for UI hooks)
actor.sync.send(event);
actor.sync.stop();
actor.sync.snapshot();
actor.sync.matches(tag);
actor.sync.can(event);
```

## ask / reply

Events declare reply schemas via `Event.reply()`. Handlers use `Machine.reply()`:

```ts
const MyEvent = Event({
  GetCount: Event.reply({}, Schema.Number),
  Reset: {},
});

.on(State.Active, Event.GetCount, ({ state }) =>
  Machine.reply(state, state.count),
)

const count = yield* actor.ask(Event.GetCount);  // number
```

## Handler Type Constraints

| Method                       | Allowed R | Why                                   |
| ---------------------------- | --------- | ------------------------------------- |
| `.on()` / `.reenter()`       | `never`   | Pure transitions, no services         |
| `.spawn()` / `.background()` | `Scope`   | Finalizers allowed                    |
| `spawn(..., { slots })`      | Any R     | Slot implementations can use services |

- Handlers cannot require arbitrary services — use slots
- Handlers cannot produce errors — error channel fixed to `never`
- Handlers must return machine's state schema — wrong states rejected at compile time

## Gotchas

- Never `throw` in Effect.gen — use `yield* Effect.fail()`
- `yield* Effect.yieldNow` after `send()` to let effects run
- `simulate()`/`createTestHarness()` don't run spawn effects
- Same-state transitions skip spawn/finalizers — use `.reenter()` to force
- Empty structs: `State.Idle` not `State.Idle()`
- `.onAny()` only fires when no specific `.on()` matches
- `self.spawn` errors with `DuplicateActorError` — wrap with `Effect.orDie`
- Sync helpers live on `actor.sync.*`
- Pending `call`/`ask` Deferreds settled with `ActorStoppedError` on stop
- `ask()` only accepts events with `Event.reply()` — non-reply events are a type error
- Reply decode failures (schema mismatch) are defects

## Cluster / Entity Machines

Wire machines to `@effect/cluster` for distributed actors:

```ts
import { toEntity, EntityMachine } from "effect-machine/cluster";

const OrderEntity = toEntity(orderMachine, { type: "Order" });
const OrderEntityLayer = EntityMachine.layer(OrderEntity, orderMachine, {
  initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
  persistence: { strategy: "journal" },
});
```

- `toEntity` generates Entity with Send/Ask/GetState/WatchState RPCs
- `EntityMachine.layer` wires machine to cluster via shared runtime kernel
- `EntityActorRef`: typed client wrapper (send/ask/snapshot/watch/waitFor)

### Entity Persistence

Opt-in via `EntityMachineOptions.persistence`:

- **Snapshot strategy** (default): background scheduler + deactivation finalizer
- **Journal strategy**: inline event append on each RPC, replay on reactivation
- `PersistenceAdapter` service tag resolved from context
- Journal append failures defect entity — cluster retry restarts from snapshot
- Hydration: snapshot → journal replay → `initializeState` → `machine.initial`

### Cluster Gotchas

- Entity tests use `Entity.makeTestClient` + `ShardingConfig.layer` + `Effect.scoped`
- `EntityMachine.layer` accepts raw `Machine`
- Entity RPCs use `.tag` field (not `._tag`) to distinguish request types
- WatchState test skipped due to effect beta Queue bug

## Documentation

- `SKILL.md` — AI agent quick reference
