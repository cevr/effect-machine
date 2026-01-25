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

## Gotchas

- Guards evaluated in registration order - first pass wins
- `always` transitions max 100 iterations (infinite loop protection)
- `delay` requires `Effect.scoped` + `ActorSystemDefault` layer
- TestClock: use `Layer.merge(ActorSystemDefault, TestContext.TestContext)`
- `simulate`/`createTestHarness` are pure - no onEnter/onExit effects
- Actor testing needs `yieldFibers` after `send()` to let effects run

## Documentation

- `CODEMAP.md` - codebase navigation
- `primer/` - comprehensive usage guide
