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
- States/Events: use branded `State<T>` / `Event<T>` types and constructors (NOT `Data.TaggedEnum`)
- Exports: all public API via `src/index.ts`
- Strict Effect config: see `tsconfig.json` for `@effect/language-service` rules
- Namespace pattern: `import { Machine } from "effect-machine"` then `Machine.make`, `Machine.on`, etc.
- `Machine` is Pipeable: use `.pipe()` for fluent API

## Gotchas

- Guards evaluated in registration order - first pass wins
- `always` transitions max 100 iterations (infinite loop protection)
- `delay` requires `Effect.scoped` + `ActorSystemDefault` layer
- TestClock: use `Layer.merge(ActorSystemDefault, TestContext.TestContext)`
- `simulate`/`createTestHarness` are pure - no onEnter/onExit/invoke effects
- Actor testing needs `yieldFibers` after `send()` to let effects run
- Same-state transitions skip exit/enter by default
- `on.force()` runs exit/enter even on same state tag - use to restart timers/invoke
- Dynamic delay: duration fn evaluated at state entry, not registration time
- `always` fallback: last branch without guard matches unconditionally
- `Machine.from(State).pipe()` scopes `on` calls - omit state arg inside scope
- `Machine.any(S1, S2, ...)` creates transitions for each state - guards typed to union
- `namespace.ts` exports Machine namespace (not `Machine.ts` - macOS case-insensitivity)
- Branded types: `State<T>` / `Event<T>` prevent accidental swap at compile time
- Brand is phantom (type-level only) - runtime values identical to `Data.TaggedEnum`

## Effect Slots

- `invoke`, `onEnter`, `onExit` take slot name, not inline handler: `Machine.invoke(State.Loading, "fetchData")`
- Provide handlers via `Machine.provide(machine, { fetchData: ... })` before spawning
- Spawning machine with unprovided slots → runtime error
- `simulate()` works without providing effects (pure transitions only)
- Effects type param `_Effects` is phantom - TypeScript won't catch unprovided slots at compile time

## Effect Language Service

- Maximally strict config in `tsconfig.json`
- `strictBooleanExpressions`: use `=== undefined` not truthy checks
- Disable per-file: `// @effect-diagnostics ruleName:off`
- Tests use `// @effect-diagnostics strictEffectProvide:off` (tests are entry points)

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
