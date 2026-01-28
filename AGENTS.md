# effect-machine

Type-safe state machines for Effect. XState-inspired API.

## Commands

```bash
bun test              # Run tests
bun run typecheck     # TypeScript check
bun run lint          # oxlint
bun run fmt           # oxfmt
```

## Conventions

- Files: kebab-case (`actor-system.ts`, `on-enter.ts`)
- States/Events: schema-first with `State({...})` / `Event({...})` - they ARE schemas
- Empty structs: plain values - `State.Idle` (not callable)
- Non-empty: `State.Loading({ url })` - constructor requiring args
- Machine creation: `Machine.make({ state, event, initial })` - types inferred from schemas
- Exports: all public API via `src/index.ts`
- Strict Effect config: see `tsconfig.json` for `@effect/language-service` rules
- Namespace pattern: `import { Machine } from "effect-machine"` then `Machine.make`, `.on()`, etc.

## Fluent Builder API

Machine uses fluent methods that mutate and return `this`:

```ts
const machine = Machine.make({ state, event, initial })
  .on(State.Idle, Event.Start, () => State.Running)
  .on(State.Running, Event.Stop, () => State.Idle)
  .final(State.Done);
```

- All builder methods mutate internal state, return `this`
- Exception: `provide()` creates new instance (supports reusing base machine with different effects)
- Internal fields prefixed `_` (`_transitions`, `_effectSlots`), public getters expose readonly views

## Gotchas

- `always` transitions max 100 iterations (infinite loop protection)
- `delay` requires `Effect.scoped` + `ActorSystemDefault` layer
- TestClock: use `Layer.merge(ActorSystemDefault, TestContext.TestContext)`
- `simulate`/`createTestHarness` run guard/effect slots in handlers but no onEnter/onExit/invoke
- Actor testing needs `yieldFibers` after `send()` to let effects run
- Same-state transitions skip exit/enter by default
- `.on.force()` runs exit/enter even on same state tag - use to restart timers/invoke
- Dynamic delay: duration fn evaluated at state entry, not registration time
- `.from(State, build)` scopes `on` calls - omit state arg inside scope
- `.onAny([S1, S2], Event, handler)` creates transitions for each state
- `namespace.ts` exports Machine namespace (not `Machine.ts` - macOS case-insensitivity)
- Branded types: `State<T>` / `Event<T>` prevent accidental swap at compile time
- Brand is phantom (type-level only) - runtime values identical to `Data.TaggedEnum`
- Schemas attached to machine: `persist` and `toEntity` infer schemas automatically

## Parameterized Slots

Guards and effects are **schema-based slots** defined via `Slot.Guards`/`Slot.Effects`:

```ts
const MyGuards = Slot.Guards({
  canRetry: { max: Schema.Number }, // parameterized
  isValid: {}, // no params
});

const MyEffects = Slot.Effects({
  fetchData: { url: Schema.String },
  notify: { message: Schema.String },
});

const machine = Machine.make({
  state: MyState,
  event: MyEvent,
  guards: MyGuards, // optional
  effects: MyEffects, // optional
  initial: MyState.Idle,
})
  // Handler receives { state, event, guards, effects }
  .on(MyState.Idle, MyEvent.Start, ({ state, guards, effects }) =>
    Effect.gen(function* () {
      if (yield* guards.canRetry({ max: 3 })) {
        yield* effects.fetchData({ url: state.url });
        return MyState.Loading({ url: state.url });
      }
      return state;
    }),
  )
  // Provide implementations - (params, ctx) signature
  .provide({
    canRetry: ({ max }, { state }) => state.attempts < max, // sync boolean ok
    fetchData: (
      { url },
      { self }, // async Effect ok
    ) =>
      Effect.gen(function* () {
        const data = yield* Http.get(url);
        yield* self.send(MyEvent.Resolve({ data }));
      }),
  });
```

**Key patterns:**

- Guards return `boolean | Effect<boolean>` - checked inside handler with `yield* guards.xxx(params)`
- Effects return `Effect<void>` - called inside handler with `yield* effects.xxx(params)`
- Handler must return `State | Effect<State>`
- Provide signature: `(params, ctx) => ...` where ctx = `{ state, event, self }`
- Guard logic in handler body - no more `guard:` option on `.on()`

## Invoke Slots

State-scoped or root-level effects (string names, not parameterized):

```ts
machine
  .invoke(State.Loading, "fetchData")   // state-scoped
  .invoke("background")                  // root-level (machine lifetime)
  .invoke(State.X, ["a", "b"])          // parallel state invokes
  .invoke(["a", "b"])                    // parallel root invokes
  .provide({ fetchData: ({ state, self }) => ... })
```

- Spawning machine with unprovided slots -> runtime error
- `simulate()` works without providing invoke effects (pure transitions only)

## Effect Language Service

- Maximally strict config in `tsconfig.json`
- `strictBooleanExpressions`: use `=== undefined` not truthy checks
- Disable per-file: `// @effect-diagnostics ruleName:off`
- Tests use `// @effect-diagnostics strictEffectProvide:off` (tests are entry points)

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
