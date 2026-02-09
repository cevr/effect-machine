# effect-machine

Type-safe state machines for Effect.

## Commands

```bash
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
  .on([State.Draft, State.Review], Event.Cancel, () => State.Cancelled)  // multi-state
  .onAny(Event.Reset, () => State.Idle)  // wildcard (any state)
  .spawn(State.Running, ({ effects }) => effects.poll())
  .final(State.Done)
  .build({ poll: () => Effect.forever(...) });
```

- Builder methods mutate `this`, return `this`
- `.build()` is terminal — returns `BuiltMachine`, no further chaining
- No-slot machines: `.build()` with no args
- `.onAny()` fires when no specific `.on()` matches for that event

## State.derive()

Construct state from existing source — picks overlapping fields, applies overrides:

```ts
// Same-state: preserve other fields
State.Active.derive(state, { count: state.count + 1 });

// Cross-state: picks only target fields from source
State.Shipped.derive(state, { trackingId: event.trackingId });

// Empty variant: returns { _tag: "Idle" }
State.Idle.derive(anyState);
```

## Slots

Guards and effects are parameterized slots:

```ts
const MyGuards = Slot.Guards({ canRetry: { max: Schema.Number } });
const MyEffects = Slot.Effects({ fetch: { url: Schema.String } });

machine
  .on(State.X, Event.Y, ({ guards, effects }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        yield* effects.fetch({ url: "/api" });
      }
      return State.Z;
    }),
  )
  .build({
    canRetry: ({ max }, { state }) => state.attempts < max,
    fetch: ({ url }, { self }) => Http.get(url).pipe(Effect.tap(() => self.send(Event.Done))),
  });
```

## Running Machines

**Simple (no registry):** caller manages lifetime via `actor.stop`. Auto-cleans up if `Scope` present.

```ts
const actor = yield * Machine.spawn(machine);
yield * actor.stop; // caller responsible

// or inside a scope — auto-cleanup on scope close:
yield *
  Effect.scoped(
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      // actor.stop called automatically
    }),
  );
```

**With registry/persistence:** actors clean up on system layer teardown.

```ts
const system = yield * ActorSystemService;
const actor = yield * system.spawn("my-id", machine);
```

**Lifecycle:** `Machine.spawn` and `system.spawn` do NOT require `Scope.Scope` in `R`. Both detect scope via `Effect.serviceOption` — if present, attach finalizer; if absent, skip. Forgetting `actor.stop` without a scope = permanent fiber leak.

## Child Actors

Spawn children from `.spawn()`/`.background()` handlers via `self.spawn(id, childMachine)`:

```ts
machine
  .spawn(State.Active, ({ self }) =>
    Effect.gen(function* () {
      const child = yield* self.spawn("worker-1", workerMachine);
      yield* child.send(WorkerEvent.Start);
      // child auto-stopped when parent exits Active state
    }),
  )
  .build();
```

- Children spawned in `.spawn()` handlers are **state-scoped** — auto-stopped on state exit
- Children spawned in `.background()` handlers live for machine lifetime
- `self.spawn` returns `Effect<ActorRef, DuplicateActorError, R>` — use `Effect.orDie` in handlers since error channel must be `never`
- Every `ActorRef` has `actor.system` for external child access: `actor.system.get("worker-1")`
- Every actor always has a system — `Machine.spawn` creates an implicit one if none in context

## ActorRef API

```ts
actor.send(event); // Effect — queue event
actor.sendSync(event); // Sync fire-and-forget (for UI hooks)
actor.waitFor(State.Active); // Wait for state (accepts constructor or predicate)
actor.sendAndWait(ev, State.X); // Send + wait for state
actor.awaitFinal; // Wait for final state
actor.subscribe(fn); // Sync callback, returns unsubscribe
actor.system; // ActorSystem — access child actors via .get(id)
actor.children; // ReadonlyMap<string, ActorRef> — child actors spawned via self.spawn
```

## System Observation

Observe actors joining/leaving the system:

```ts
const system = yield * ActorSystemService;

// Sync callback (like ActorRef.subscribe pattern)
const unsub = system.subscribe((event) => {
  // event: { _tag: "ActorSpawned" | "ActorStopped", id: string, actor: ActorRef }
});

// Sync snapshot of all registered actors
const actors: ReadonlyMap<string, ActorRef> = system.actors;

// Async stream (each subscriber gets own queue — late subscribers miss prior events)
yield *
  system.events.pipe(
    Stream.tap((e) => Effect.log(e._tag, e.id)),
    Stream.runDrain,
  );
```

- `system.actors` returns a new Map on each access (snapshot, not live)
- No events emitted during system teardown (PubSub is shutting down)
- Works with both explicit (`ActorSystemDefault`) and implicit (`Machine.spawn`) systems

## spawn vs on

- `.on()` - transitions, guards/effects run inline
- `.spawn()` - state-scoped effects, forked, auto-cancelled on exit
- `.background()` - machine-lifetime effects

## Handler Type Constraints

Handlers are strictly typed - `.build()` is the only way to add requirements:

| Method                       | Allowed R | Why                                        |
| ---------------------------- | --------- | ------------------------------------------ |
| `.on()` / `.reenter()`       | `never`   | Pure transitions, no services              |
| `.spawn()` / `.background()` | `Scope`   | Finalizers allowed (`Effect.addFinalizer`) |
| `.build()`                   | Any R     | Slot implementations can use services      |

- Handlers cannot require arbitrary services - use slots + `build()`
- Handlers cannot produce errors - error channel fixed to `never`
- Handlers must return machine's state schema - wrong states rejected at compile time

## Gotchas

- Never `throw` in Effect.gen - use `yield* Effect.fail()`
- `yield* Effect.yieldNow()` after `send()` to let effects run
- `simulate()`/`createTestHarness()` don't run spawn effects
- Same-state transitions skip spawn/finalizers - use `.reenter()` to force
- TestClock needs `TestContext.TestContext` layer
- Empty structs: `State.Idle` not `State.Idle()`
- `.onAny()` only fires when no specific `.on()` matches
- `.build()` is terminal — no `.on()`, `.final()` after it
- `self.spawn` errors with `DuplicateActorError` — handlers require `never` error, so wrap with `Effect.orDie`

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
- `SKILL.md` - AI agent quick reference
