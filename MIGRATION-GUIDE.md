# Effect v3 → v4 Migration Guide

API changes applied to `src/` and `test/` (v4). Reference `src-v3/` for original v3 code.

## Module Renames

| v3                                 | v4                                    | Notes                    |
| ---------------------------------- | ------------------------------------- | ------------------------ |
| `import { Context } from "effect"` | `import { ServiceMap } from "effect"` | `Context` module removed |
| `import { Either } from "effect"`  | `import { Result } from "effect"`     | `Either` module removed  |
| `@effect/cluster`                  | `effect/unstable/cluster`             | Moved to unstable        |
| `@effect/rpc`                      | `effect/unstable/rpc`                 | Moved to unstable        |

## Context / Service Tags

| v3                            | v4                                   |
| ----------------------------- | ------------------------------------ |
| `Context.GenericTag<T>(key)`  | `ServiceMap.Service<T>(key)`         |
| `Context.Tag(key)<Self, T>()` | `ServiceMap.Service<Self, T>()(key)` |
| `Context.Tag<I, S>` (type)    | `ServiceMap.Service<I, S>` (type)    |
| `Context.make(tag, value)`    | `ServiceMap.make(tag, value)`        |
| `Context.get(ctx, tag)`       | `ServiceMap.get(ctx, tag)`           |

## Schema

| v3                                         | v4                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `Schema.TaggedError<T>()(tag, fields)`     | `Schema.TaggedErrorClass<T>()(tag, fields)`                                                           |
| `Schema.Union(A, B, C)`                    | `Schema.Union([A, B, C])`                                                                             |
| `Schema.Literal("a", "b")`                 | `Schema.Literals(["a", "b"])`                                                                         |
| `Schema.Literal("a")`                      | `Schema.Literal("a")` (single: same)                                                                  |
| `Schema.Schema<T, E, R>`                   | `Schema.Schema<T>` (decoded only) or `Schema.Codec<T, E, RD, RE>`                                     |
| `Schema.Schema.All`                        | `Schema.Top`                                                                                          |
| `Schema.Schema.Any`                        | `Schema.Top`                                                                                          |
| `Schema.Schema.Type<S>`                    | `Schema.Schema.Type<S>` (unchanged — `S["Type"]`)                                                     |
| `Schema.Struct.Constructor<F>`             | `Schema.Struct.Type<F>`                                                                               |
| `Schema.encode(s)(v)`                      | `Schema.encodeEffect(s)(v)`                                                                           |
| `Schema.decode(s)(v)`                      | `Schema.decodeEffect(s)(v)`                                                                           |
| `Schema.encodeSync(s)(v)`                  | `Schema.encodeSync(s)(v)` (same API, but `s` must satisfy `Top & { EncodingServices: never }`)        |
| `Schema.decodeUnknownSync(s)(v)`           | `Schema.decodeUnknownSync(s)(v)` (same API, but `s` must satisfy `Top & { DecodingServices: never }`) |
| `Schema.optional(S)`                       | `Schema.optional(S)` (same API, wraps `UndefinedOr` + `optionalKey` internally)                       |
| `new TaggedError()` (0 args, empty fields) | `new TaggedErrorClass({})` (requires `{}` even for empty fields)                                      |

### Schema type system

v4 splits the schema hierarchy:

- `Schema.Top` — base for all schemas (replaces `Schema.Schema.All` / `Schema.Schema.Any`)
- `Schema.Schema<T>` — only carries decoded type `T` (has `.Type`)
- `Schema.Codec<T, E, RD, RE>` — full encode/decode with services (has `.Type`, `.Encoded`, `.DecodingServices`, `.EncodingServices`)
- `Schema.Bottom<T, E, RD, RE, ...>` — internal, carries all type-level info

When a function needs to encode/decode (like persistence adapters), use `Schema.Codec<S, unknown, never, never>` to require no service dependencies. Plain `Schema.Schema<S>` won't constrain the services channel and causes `unknown` leaks in the `R` position.

**Practical impact:** If you have a custom type that wraps `Schema.Schema<T>`, switch to `Schema.Codec<T, unknown, never, never>` so it works with `encodeSync`/`decodeUnknownSync`. These functions require `Top & { EncodingServices: never }` / `Top & { DecodingServices: never }` — `Schema.Schema<T>` leaves services as `unknown`, which won't match. The underlying runtime schema objects (e.g. `Schema.Union`, `Schema.Struct`) already carry `never` services, so the fix is purely at the type level.

## Effect

| v3                            | v4                                                                      |
| ----------------------------- | ----------------------------------------------------------------------- |
| `Effect.fork(e)`              | `Effect.forkChild(e)`                                                   |
| `Effect.forkDaemon(e)`        | `Effect.forkDetach(e)`                                                  |
| `Effect.forkAll(effects)`     | Removed                                                                 |
| `Effect.catchAll(e, f)`       | `Effect.catchEager(e, f)` (also `Effect.catch` per migration docs)      |
| `Effect.catchAllCause(e, f)`  | `Effect.catchCause(e, f)`                                               |
| `Effect.catchAllDefect(e, f)` | `Effect.catchDefect(e, f)`                                              |
| `Effect.zipRight(a, b)`       | `Effect.andThen(a, b)`                                                  |
| `Effect.either(e)`            | `Effect.result(e)` → returns `Result` not `Either`                      |
| `Effect.repeatN(n)`           | `Effect.repeat({ times: n })` or `Effect.repeat(Schedule.recurs(n))`    |
| `Effect.serviceOptional(tag)` | `Effect.serviceOption(tag)` → returns `Effect<Option<S>>` (no `I` in R) |
| `Effect.yieldNow()`           | `Effect.yieldNow` (value, not function call)                            |
| `Effect.dieMessage(msg)`      | `Effect.die(msg)` — `die` now accepts `unknown` directly                |
| `Effect.void`                 | `Effect.void` (unchanged — still a value)                               |
| `Effect.try(() => ...)`       | Removed — use `Effect.sync` with try/catch or `Effect.suspend`          |
| `Runtime.runFork(rt)`         | `Effect.runFork` / `Effect.runForkWith(services)` for custom context    |
| `Effect.EffectTypeId`         | Not exported — use `Effect.isEffect(value)` instead                     |
| `Effect.runSync(e)`           | `Effect.runSync(e)` (unchanged)                                         |
| `Effect.runFork(e)`           | `Effect.runFork(e)` (unchanged — now directly on Effect, not Runtime)   |

### Effect.serviceOption behavior change

v3 `Effect.serviceOptional(tag)` returned `Effect<S, NoSuchElementException, I>` — the service `I` stayed in `R`.
v4 `Effect.serviceOption(tag)` returns `Effect<Option<S>>` — no `I` in R, just gives you `Option`.

Pattern migration:

```ts
// v3
const ctx = yield * Effect.serviceOptional(tag).pipe(Effect.orDie);

// v4
const maybeCtx = yield * Effect.serviceOption(tag);
if (Option.isNone(maybeCtx)) return yield * Effect.die("not available");
const ctx = maybeCtx.value;
```

## Result (replaces Either)

`Either` module removed. `Effect.result(e)` returns `Result<A, E>` instead of `Either<A, E>`.

| v3 (Either)               | v4 (Result)                 |
| ------------------------- | --------------------------- |
| `result._tag === "Left"`  | `result._tag === "Failure"` |
| `result._tag === "Right"` | `result._tag === "Success"` |
| `result.left`             | `result.failure`            |
| `result.right`            | `result.success`            |
| `Either.isLeft(r)`        | `Result.isFailure(r)`       |
| `Either.isRight(r)`       | `Result.isSuccess(r)`       |

## Cause

| v3                                               | v4                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `Cause.isInterruptedOnly(cause)`                 | `Cause.hasInterruptsOnly(cause)`                                               |
| Cause is a tree (`Sequential`, `Parallel`, etc.) | Cause is flat (`cause.reasons: ReadonlyArray<Reason>`)                         |
| `Cause.isFailure(c)` etc.                        | `Cause.hasFails(c)`, `Cause.hasDies(c)`, `Cause.hasInterrupts(c)`              |
| Pattern match on `_tag`                          | Filter `cause.reasons` with `isFailReason`, `isDieReason`, `isInterruptReason` |
| `Cause.failures(c)` → `Chunk`                    | `cause.reasons.filter(Cause.isFailReason).map(r => r.error)`                   |

## Scope

| v3                     | v4                |
| ---------------------- | ----------------- |
| `Scope.CloseableScope` | `Scope.Closeable` |

## Layer

| v3                          | v4                                                        |
| --------------------------- | --------------------------------------------------------- |
| `Layer.scoped(tag, effect)` | `Layer.effect(tag, effect)` (handles Scope automatically) |
| `Layer.unwrapEffect(e)`     | `Layer.unwrap(e)`                                         |

`Layer.effect` in v4 has signature `<I, S, E, R>(tag, effect) => Layer<I, E, Exclude<R, Scope>>` — it strips `Scope` from requirements automatically, so `Layer.scoped` is no longer needed.

## Schedule

| v3                          | v4                                                                   |
| --------------------------- | -------------------------------------------------------------------- |
| `Schedule.driver(schedule)` | `Schedule.toStep(schedule)` → returns step fn `(now, input) => Pull` |
| `driver.next(input)`        | `step(now, input)` (get `now` from `Clock.currentTimeMillis`)        |
| `Schedule.stop`             | `Schedule.recurs(0)`                                                 |

`Schedule.toStep` returns `Effect<(now: number, input: Input) => Pull.Pull<[Output, Duration], Error, Output, Env>>`. When the pull fails with `Cause.Done`, the schedule is exhausted.

## Brand

| v3                           | v4                                           |
| ---------------------------- | -------------------------------------------- |
| `Brand.Brand<unique symbol>` | `Brand.Brand<string>` — keys must be strings |

Use string literal types instead of `unique symbol`:

```ts
// v3
declare const MyId: unique symbol;
interface MyBrand extends Brand.Brand<typeof MyId> {}

// v4
interface MyBrand extends Brand.Brand<"my-package/MyBrand"> {}
```

## SubscriptionRef

| v3                       | v4                                                                |
| ------------------------ | ----------------------------------------------------------------- |
| `ref.changes` (property) | `SubscriptionRef.changes(ref)` (function)                         |
| `ref.get` (yieldable)    | Removed — use `SubscriptionRef.get(ref)`                          |
| `yield* ref` (yieldable) | No longer works — `SubscriptionRef` no longer implements `Effect` |

`SubscriptionRef` in v4 is a plain `Pipeable` with `.backing`, `.semaphore`, and `.pubsub` — it does not extend `Effect`. All access goes through static functions:

```ts
// v3
const value = yield * ref;
const value = yield * ref.get;
const stream = ref.changes;

// v4
const value = yield * SubscriptionRef.get(ref);
const stream = SubscriptionRef.changes(ref);
```

## Testing

| v3                                      | v4                                              |
| --------------------------------------- | ----------------------------------------------- |
| `import { TestContext } from "effect"`  | `import { TestClock } from "effect/testing"`    |
| `import { TestClock } from "effect"`    | `import { TestClock } from "effect/testing"`    |
| `import { TestServices } from "effect"` | Removed — no unified test services type         |
| `TestContext.TestContext` (layer)       | `TestClock.layer()` — compose individual layers |
| `TestServices.TestServices` (type)      | `TestClock.TestClock` (type for R channel)      |
| `TestClock.adjust("1 second")`          | `TestClock.adjust("1 second")` (unchanged)      |

v4 has no unified `TestContext` — provide test layers individually:

```ts
// v3
Effect.provide(TestContext.TestContext);

// v4
Effect.provide(TestClock.layer());
```

### effect-bun-test

`effect-bun-test@0.2.0` supports v4. Update with `bun add -d effect-bun-test@0.2.0`.

v0.2.0 internally uses `TestClock.layer()` from `effect/testing`, `Effect.yieldNow` (value), and `Effect.repeat({ times: 9 })`. No API changes to test code — `it.effect`, `it.scoped`, `it.live`, `yieldFibers` all work the same.

## Runtime

| v3                            | v4                                                                       |
| ----------------------------- | ------------------------------------------------------------------------ |
| `Runtime<R>` (generic)        | Removed — use `ServiceMap<R>` for services                               |
| `Runtime.runFork(rt)(effect)` | `Effect.runFork(effect)` or `Effect.runForkWith(services)(effect)`       |
| `Effect.runtime<R>()`         | Not needed for `R = never`; use `Effect.runForkWith` for custom services |

## oxlint Gotchas

- `import/namespace` rule false-positives on `import type { Brand } from "effect"` — oxlint can't resolve type-only namespace members. Suppress with `eslint-disable-next-line eslint-plugin-import/namespace`.
- Exclude `src-v3/` from linting (it uses v3 APIs that don't exist in the v4 `effect` package): add `"**/src-v3/**"` to `ignorePatterns` in `.oxlintrc.json`.

## File Structure

```
src/        → v4 (Effect 4.0.0-beta.5) — typechecks clean
test/       → v4 — typechecks clean, 213 tests passing
src-v3/     → v3 (Effect 3.x) — frozen, unchanged
dist/       → v4 build output
dist-v3/    → v3 build output
```

## Exports

```json
{
  ".": "dist/index.js",
  "./v3": "dist-v3/index.js",
  "./cluster": "dist/cluster/index.js"
}
```

## Bulk Migration Strategy

Order matters. Fix src/ first, then tests. Within each, start with mechanical replacements before tackling structural issues.

### Phase 1: Mechanical find-replace (covers ~80% of errors)

These are safe to apply globally with find-replace:

```
Effect.either         → Effect.result
Effect.fork(          → Effect.forkChild(         (careful: not forkChild/forkDetach)
Effect.forkDaemon     → Effect.forkDetach
Effect.catchAll       → Effect.catchEager         (careful: not catchAllCause/catchAllDefect)
Effect.catchAllCause  → Effect.catchCause
Effect.catchAllDefect → Effect.catchDefect
Effect.yieldNow()     → Effect.yieldNow
Effect.dieMessage     → Effect.die
Schedule.stop         → Schedule.recurs(0)
Layer.scoped(         → Layer.effect(
```

### Phase 2: Import rewrites

```
import { TestClock } from "effect"     → import { TestClock } from "effect/testing"
import { Context, ... } from "effect"  → import { ServiceMap, ... } from "effect"
@effect/cluster                        → effect/unstable/cluster
@effect/rpc                            → effect/unstable/rpc
```

Add `SubscriptionRef` to effect imports when any file uses `ref.get` or `ref.changes`.

### Phase 3: Pattern rewrites (need context)

These require understanding the surrounding code:

- `result._tag === "Left"` → `"Failure"`, `"Right"` → `"Success"`, `.left` → `.failure`, `.right` → `.success`
- `ref.get` / `yield* ref` → `SubscriptionRef.get(ref)`
- `ref.changes` → `SubscriptionRef.changes(ref)`
- `Context.GenericTag<T>(key)` → `ServiceMap.Service<T>(key)`
- `class X extends Context.Tag(key)<Self, T>()` → `class X extends ServiceMap.Service<Self, T>()(key)`
- `Schema.Literal("a", "b")` → `Schema.Literals(["a", "b"])`
- `Schema.Union(A, B, C)` → `Schema.Union([A, B, C])`
- `Schema.TaggedError` → `Schema.TaggedErrorClass`
- `new TaggedErrorClass()` → `new TaggedErrorClass({})` (empty fields still need `{}`)
- `Schema.Schema<T>` in type positions that need encode/decode → `Schema.Codec<T, unknown, never, never>`

### Phase 4: Typecheck + iterate

Run `tsc --noEmit` after each phase. The remaining errors are usually:

- `unknown` leaking into R/E channels from `Schema.Schema` → switch to `Schema.Codec`
- Structural type mismatches from `ServiceMap.Service` class patterns
- `Schema.Literal` type narrowing (single-arg returns literal type, multi-arg was union)
