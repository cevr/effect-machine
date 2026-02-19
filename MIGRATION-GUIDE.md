# Effect v3 → v4 Migration Guide

API changes applied to `src/` (v4). Reference `src-v3/` for original v3 code.

## Module Renames

| v3                                 | v4                                    | Notes                    |
| ---------------------------------- | ------------------------------------- | ------------------------ |
| `import { Context } from "effect"` | `import { ServiceMap } from "effect"` | `Context` module removed |
| `@effect/cluster`                  | `effect/unstable/cluster`             | Moved to unstable        |
| `@effect/rpc`                      | `effect/unstable/rpc`                 | Moved to unstable        |

## Context / Service Tags

| v3                            | v4                                   |
| ----------------------------- | ------------------------------------ |
| `Context.GenericTag<T>(key)`  | `ServiceMap.Service<T>(key)`         |
| `Context.Tag(key)<Self, T>()` | `ServiceMap.Service<Self, T>()(key)` |
| `Context.Tag<I, S>` (type)    | `ServiceMap.Service<I, S>` (type)    |

## Schema

| v3                                         | v4                                                                |
| ------------------------------------------ | ----------------------------------------------------------------- |
| `Schema.TaggedError<T>()(tag, fields)`     | `Schema.TaggedErrorClass<T>()(tag, fields)`                       |
| `Schema.Union(A, B, C)`                    | `Schema.Union([A, B, C])`                                         |
| `Schema.Literal("a", "b")`                 | `Schema.Literals(["a", "b"])`                                     |
| `Schema.Literal("a")`                      | `Schema.Literal("a")` (single: same)                              |
| `Schema.Schema<T, E, R>`                   | `Schema.Schema<T>` (decoded only) or `Schema.Codec<T, E, RD, RE>` |
| `Schema.Schema.All`                        | `Schema.Top`                                                      |
| `Schema.Schema.Any`                        | `Schema.Top`                                                      |
| `Schema.Schema.Type<S>`                    | `Schema.Schema.Type<S>` (unchanged)                               |
| `Schema.Struct.Constructor<F>`             | `Schema.Struct.Type<F>`                                           |
| `Schema.encode(s)(v)`                      | `Schema.encodeEffect(s)(v)`                                       |
| `Schema.decode(s)(v)`                      | `Schema.decodeEffect(s)(v)`                                       |
| `Schema.optional(S)`                       | `Schema.optional(S)` (same API, different internals)              |
| `new TaggedError()` (0 args, empty fields) | `new TaggedErrorClass({})` (requires `{}`)                        |

## Effect

| v3                            | v4                                                         |
| ----------------------------- | ---------------------------------------------------------- |
| `Effect.fork(e)`              | `Effect.forkChild(e)`                                      |
| `Effect.forkDaemon(e)`        | `Effect.forkDetach(e)`                                     |
| `Effect.catchAll(e, f)`       | `Effect.catchEager(e, f)`                                  |
| `Effect.catchAllCause(e, f)`  | `Effect.catchCause(e, f)`                                  |
| `Effect.zipRight(a, b)`       | `Effect.andThen(a, b)`                                     |
| `Effect.either(e)`            | `Effect.result(e)` → returns `Result` not `Either`         |
| `Effect.serviceOptional(tag)` | `Effect.serviceOption(tag)` → returns `Effect<Option<S>>`  |
| `Effect.yieldNow()`           | `Effect.yieldNow` (value, not function)                    |
| `Effect.void`                 | `Effect.void` (unchanged — still a value)                  |
| `Effect.try(() => ...)`       | `Effect.sync(() => { try { ... } catch {} })`              |
| `Runtime.runFork(rt)`         | `Effect.runFork` (no runtime param needed for `R = never`) |
| `Effect.EffectTypeId`         | Not exported — use `Effect.isEffect(value)` instead        |

## Result (replaces Either in Effect.result)

| v3 (Either)               | v4 (Result)                 |
| ------------------------- | --------------------------- |
| `result._tag === "Left"`  | `result._tag === "Failure"` |
| `result._tag === "Right"` | `result._tag === "Success"` |
| `result.left`             | `result.failure`            |
| `result.right`            | `result.success`            |

## Cause

| v3                                               | v4                                                     |
| ------------------------------------------------ | ------------------------------------------------------ |
| `Cause.isInterruptedOnly(cause)`                 | `Cause.hasInterruptsOnly(cause)`                       |
| Cause is a tree (`Sequential`, `Parallel`, etc.) | Cause is flat (`cause.reasons: ReadonlyArray<Reason>`) |

## Scope

| v3                     | v4                |
| ---------------------- | ----------------- |
| `Scope.CloseableScope` | `Scope.Closeable` |

## Layer

| v3                          | v4                                                        |
| --------------------------- | --------------------------------------------------------- |
| `Layer.scoped(tag, effect)` | `Layer.effect(tag, effect)` (handles Scope automatically) |
| `Layer.unwrapEffect(e)`     | `Layer.unwrap(e)`                                         |

## Schedule

| v3                          | v4                                                                   |
| --------------------------- | -------------------------------------------------------------------- |
| `Schedule.driver(schedule)` | `Schedule.toStep(schedule)` → returns step fn `(now, input) => Pull` |
| `driver.next(input)`        | `step(now, input)` (get `now` from `Clock.currentTimeMillis`)        |

## Brand

| v3                           | v4                                           |
| ---------------------------- | -------------------------------------------- |
| `Brand.Brand<unique symbol>` | `Brand.Brand<string>` — keys must be strings |

## SubscriptionRef

| v3            | v4                                                      |
| ------------- | ------------------------------------------------------- |
| `ref.changes` | `SubscriptionRef.changes(ref)` (function, not property) |

## Test-Specific (pending migration)

| v3                        | v4                            |
| ------------------------- | ----------------------------- |
| `TestContext.TestContext` | Check `effect/testing` module |
| `TestServices`            | Check `effect/testing` module |
| `effect-bun-test`         | Needs v4-compatible version   |

## File Structure

```
src/        → v4 (Effect 4.0.0-beta.5) — typechecks clean
src-v3/     → v3 (Effect 3.x) — frozen, unchanged
dist/       → v4 build output
dist-v3/    → v3 build output
```

## Exports

```json
{
  ".": "dist/index.js", // v4 (default)
  "./v3": "dist-v3/index.js", // v3 compat
  "./cluster": "dist/cluster/index.js"
}
```
