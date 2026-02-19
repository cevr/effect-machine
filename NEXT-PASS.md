# Next Pass: Test Migration to Effect v4

~222 real TS errors across 19 test files. All mechanical — same patterns as src/.

## Prerequisite: Fix `effect-bun-test`

`effect-bun-test` is broken against v4. Needs a v4-compatible fork or inline replacement.

Changes needed:
- `import { TestContext } from "effect"` → `import { TestClock } from "effect/testing"`
- `TestContext.TestContext` layer → `TestClock.layer()` (provides just TestClock, not full TestServices)
- `Effect.yieldNow()` → `Effect.yieldNow` (value, not function call)
- `Effect.repeatN(9)` → `Effect.repeat({ times: 9 })` or `Effect.repeat(Schedule.recurs(9))`
- `TestServices.TestServices` type → figure out v4 equivalent (may just be `TestClock`)

Simplest fix: inline the test helpers or fork `effect-bun-test` with v4 compat.

## Bulk Replacements (mechanical)

### 1. Imports — 6 files

| Find | Replace | Files |
|------|---------|-------|
| `import { Context, ...` | `import { ServiceMap, ...` | actor.test.ts, type-constraints.test.ts |
| `import { TestClock } from "effect"` | `import { TestClock } from "effect/testing"` | reenter.test.ts, timeouts.task.test.ts, patterns/session-lifecycle.test.ts, patterns/payment-flow.test.ts |

### 2. Effect API renames — ~30 sites

| Find | Replace | Count |
|------|---------|-------|
| `Effect.either` | `Effect.result` | 11 |
| `Effect.fork` (not forkChild/forkDetach) | `Effect.forkChild` | 2 |
| `Effect.forkDaemon` | `Effect.forkDetach` | 2 |
| `Effect.catchAll` | `Effect.catchEager` | 2 |
| `Effect.catchAllCause` | `Effect.catchCause` | 2 |
| `Effect.yieldNow()` | `Effect.yieldNow` | usage in effect-bun-test |

### 3. Result instead of Either — ~11 sites

After `Effect.result(...)`:
- `result._tag === "Left"` → `result._tag === "Failure"`
- `result._tag === "Right"` → `result._tag === "Success"`
- `result.left` → `result.failure`
- `result.right` → `result.success`

### 4. SubscriptionRef — ~31 sites

| Find | Replace |
|------|---------|
| `actor.state.get` (property access) | `SubscriptionRef.get(actor.state)` |

Pattern: `(yield* actor.state.get)._tag` → `(yield* SubscriptionRef.get(actor.state))._tag`

Affected files: actor.test.ts, child-actor.test.ts, patterns/*.test.ts, reenter.test.ts, timeouts.task.test.ts

### 5. Schedule — 5 sites

| Find | Replace |
|------|---------|
| `Schedule.stop` | `Schedule.recurs(0)` |

All in persistence.test.ts.

### 6. Layer — 2 sites

| Find | Replace |
|------|---------|
| `Layer.scoped(tag, effect)` | `Layer.effect(tag, effect)` |

In actor.test.ts.

### 7. Schema — 3 sites

| Find | Replace |
|------|---------|
| `Schema.TaggedError` | `Schema.TaggedErrorClass` |
| `Schema.decode(schema)` | `Schema.decodeEffect(schema)` |
| `Schema.encode(schema)` | `Schema.encodeEffect(schema)` |

In type-constraints.test.ts, schema.test.ts.

### 8. Context → ServiceMap — 2 sites

| Find | Replace |
|------|---------|
| `Context.GenericTag` | `ServiceMap.Service` |

In actor.test.ts, type-constraints.test.ts.

## Non-Mechanical Fixes

### Stream.take result type changed

actor-system-observation.test.ts uses `Stream.runCollect(system.events.pipe(Stream.take(2)))` — the `Chunk` result type may have changed. Check `Chunk.toReadonlyArray` or direct iteration.

### Persistence schema types

persistence.test.ts passes `MachineStateSchema` as schema arg to adapter — now needs to satisfy `Schema.Codec<S, unknown, never, never>` constraint. May need cast since `MachineStateSchema` extends `Schema.Schema<T>`, not `Codec`.

### Cluster test imports

test/integration/cluster.test.ts:
- `@effect/cluster` → `effect/unstable/cluster`
- `@effect/rpc` → `effect/unstable/rpc`
- Entity/Rpc APIs may have changed in v4

### Schema.Literal type narrowing

schema.test.ts uses `Schema.Literal("guest")` in struct fields — the `Literal` type changed from multi-arg to single-arg. Existing single-arg usage is fine, but type narrowing on values like `role: "user"` may break if the Literal type representation changed.

## Execution Order

1. Fix/replace `effect-bun-test` (blocker — tests can't even import)
2. Bulk find-replace across all test files (mechanical)
3. Fix non-mechanical issues (stream types, schema codec constraints, cluster)
4. Run `bun run typecheck` — iterate on remaining errors
5. Run `bun test` — fix runtime failures
6. Re-enable pre-commit hook (remove `--no-verify`)

## File-by-File Error Counts

| File | Errors | Main issues |
|------|--------|-------------|
| child-actor.test.ts | 36 | SubscriptionRef.get, Effect.forkDetach, yieldNow |
| actor.test.ts | 35 | Context→ServiceMap, Either→Result, SubscriptionRef.get, Layer.scoped |
| persistence.test.ts | 33 | Schedule.stop, schema Codec constraint, Effect scope types |
| patterns/session-lifecycle.test.ts | 25 | TestClock import, SubscriptionRef.get, Literal narrowing |
| timeouts.task.test.ts | 18 | TestClock import, SubscriptionRef.get, scope types |
| patterns/payment-flow.test.ts | 14 | TestClock import, SubscriptionRef.get |
| testing.test.ts | 12 | Effect.either→result, Either→Result destructuring |
| actor-system-observation.test.ts | 12 | Effect.fork, Stream.take, yieldNow |
| reenter.test.ts | 10 | TestClock import, SubscriptionRef.get |
| schema.test.ts | 9 | Schema.decode→decodeEffect, Literal types |
| inspection.test.ts | 9 | Effect scope types |
| patterns/keyboard-input.test.ts | 6 | Schema.Literal, SubscriptionRef.get |
| type-constraints.test.ts | 5 | Schema.TaggedError, Context→ServiceMap |
| integration/cluster.test.ts | 6 | Cluster/Rpc imports, Entity API |
| patterns/menu-navigation.test.ts | 0 | — |
| slot.test.ts | 0 | — |
| machine.test.ts | 0 | — |
| conditional-transitions.test.ts | 0 | — |
| internal/transition.test.ts | 0 | — |
