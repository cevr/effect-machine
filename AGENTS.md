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
- States/Events: `Data.taggedEnum` from Effect
- Exports: all public API via `src/index.ts`
- Strict Effect config: see `tsconfig.json` for `@effect/language-service` rules

## Gotchas

- Guards evaluated in registration order - first pass wins
- `always` transitions max 100 iterations (infinite loop protection)
- `delay` requires `Effect.scoped` + `ActorSystemDefault` layer
- TestClock: use `Layer.merge(ActorSystemDefault, TestContext.TestContext)`
- `simulate`/`createTestHarness` are pure - no onEnter/onExit effects
- Actor testing needs `yieldFibers` after `send()` to let effects run
- `internal: true` skips exit/enter even if handler returns same-state - use for context-only updates
- `reenter: true` forces exit/enter on same state tag - use to restart timers/invoke
- Dynamic delay: duration fn evaluated at state entry, not registration time

## Effect Language Service

- Maximally strict config in `tsconfig.json`
- `strictBooleanExpressions`: use `=== undefined` not truthy checks
- Disable per-file: `// @effect-diagnostics ruleName:off`
- Tests use `// @effect-diagnostics strictEffectProvide:off` (tests are entry points)

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
