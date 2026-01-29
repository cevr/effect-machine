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
  .spawn(State.Running, ({ effects }) => effects.poll())
  .provide({ poll: () => Effect.forever(...) })
  .final(State.Done);
```

- Builder methods mutate `this`, return `this`
- Exception: `provide()` creates new instance (base reusable)

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
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max,
    fetch: ({ url }, { self }) => Http.get(url).pipe(Effect.tap(() => self.send(Event.Done))),
  });
```

## spawn vs on

- `.on()` - transitions, guards/effects run inline
- `.spawn()` - state-scoped effects, forked, auto-cancelled on exit
- `.background()` - machine-lifetime effects

## Gotchas

- Never `throw` in Effect.gen - use `yield* Effect.fail()`
- `yield* Effect.yieldNow()` after `send()` to let effects run
- `simulate()`/`createTestHarness()` don't run spawn effects
- Same-state transitions skip spawn/finalizers - use `.reenter()` to force
- TestClock needs `TestContext.TestContext` layer
- Empty structs: `State.Idle` not `State.Idle()`

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
- `SKILL.md` - AI agent quick reference
