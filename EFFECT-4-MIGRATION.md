# Effect v4 Migration Plan

## Status: src/ migrated, tests pending

Target: `effect@4.0.0-beta.5` (or latest beta at time of execution)

## Strategy: Dual v3/v4 Support

Support both Effect v3 and v4 from the same repo using path aliasing:

1. Keep `src/` as-is (v3, current)
2. Create `src-v4/` — copy of `src/` migrated to v4 APIs
3. Add `effect-smol` as a dev dependency aliased to `effect@4.0.0-beta.5`
4. Separate build targets and exports for v3 vs v4
5. Publish with dual exports: `"."` (v3) and `"./v4"` (v4)

### package.json changes

```jsonc
{
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    },
    "./v4": {
      "import": { "types": "./dist-v4/index.d.ts", "default": "./dist-v4/index.js" },
    },
    "./cluster": {
      "import": { "types": "./dist/cluster/index.d.ts", "default": "./dist/cluster/index.js" },
    },
  },
  "peerDependencies": {
    // v3 peers stay for "." export
    "@effect/cluster": "^0.56.0",
    "@effect/rpc": "^0.73.0",
  },
  "devDependencies": {
    // ... existing ...
    "effect-v4": "npm:effect@4.0.0-beta.5", // alias for v4 dev/test
  },
}
```

**Alternative (simpler):** Just bump to v4 and drop v3 support. If gent is the only consumer and both migrate together, this avoids the dual-build complexity. Decide based on whether other projects depend on effect-machine v3.

## API Changes Required

### 1. `Context.Tag` / `Context.GenericTag` → `ServiceMap.Service` (4 sites)

| File                         | Tag                                       |
| ---------------------------- | ----------------------------------------- |
| `src/actor.ts`               | `ActorSystemTag` (GenericTag)             |
| `src/slot.ts`                | `MachineContextTag` (GenericTag)          |
| `src/inspection.ts`          | `InspectorTag` (GenericTag)               |
| `src/persistence/adapter.ts` | `PersistenceAdapterTag` (class-based Tag) |

```ts
// v3
export const ActorSystemTag = Context.GenericTag<ActorSystem>("effect-machine/ActorSystem");

// v4
export const ActorSystemTag = ServiceMap.Service<ActorSystem>("effect-machine/ActorSystem");
```

```ts
// v3 (class-based)
export class PersistenceAdapterTag extends Context.Tag("effect-machine/PersistenceAdapter")<
  PersistenceAdapterTag,
  PersistenceAdapter
>() {}

// v4
export class PersistenceAdapterTag extends ServiceMap.Service<
  PersistenceAdapterTag,
  PersistenceAdapter
>()("effect-machine/PersistenceAdapter") {}
```

### 2. `Schema.TaggedError` → `Schema.TaggedErrorClass` (8 sites)

File: `src/errors.ts`, `src/persistence/adapter.ts`

```ts
// v3
export class DuplicateActorError extends Schema.TaggedError<DuplicateActorError>()(
  "DuplicateActorError",
  { actorId: Schema.String },
) {}

// v4
export class DuplicateActorError extends Schema.TaggedErrorClass<DuplicateActorError>()(
  "DuplicateActorError",
  { actorId: Schema.String },
) {}
```

All 8 error classes:

- `DuplicateActorError`
- `UnprovidedSlotsError`
- `MissingSchemaError`
- `InvalidSchemaError`
- `MissingMatchHandlerError`
- `SlotProvisionError`
- `ProvisionValidationError`
- `AssertionError`
- `PersistenceError` (in adapter.ts)
- `VersionConflictError` (in adapter.ts)

### 3. `Effect.catchAll` → `Effect.catchEager` (check count in actor.ts, testing.ts, persistent-actor.ts)

Grep for `catchAll` across all source files and replace with `catchEager`.

### 4. `Effect.catchAllCause` → `Effect.catchCause`

Used in `actor.ts` event loop and `persistent-actor.ts`.

### 5. `Effect.void` → replacement

Used in several places as no-op return. Find v4 idiom.

### 6. `Effect.fork` → `Effect.forkChild`

Used in `actor.ts` for forking the event loop and spawn effects.

### 7. `Effect.forkDaemon` → `Effect.forkDetach`

Used in `actor.ts` for background effects.

### 8. `Effect.serviceOptional` / `Effect.serviceOption` → check v4 equivalents

Used in:

- `src/machine.ts` — `Effect.serviceOptional(this.Context)` for slot resolution
- `src/machine.ts` — `Effect.serviceOption(Scope.Scope)` for optional scope cleanup

### 9. `Schema.Union(A, B)` → `Schema.Union([A, B])`

Used in `src/schema.ts` for state/event union construction.

### 10. `Schema.Literal("a", "b")` → `Schema.Literals(["a", "b"])`

Check `src/schema.ts` and `src/persistence/adapter.ts` for multi-arg Literal calls.

### 11. `Cause.isInterruptedOnly` → check v4 name

Used in `src/machine.ts` task handler. v4 flattened Cause — verify this API still exists.

### 12. `@effect/cluster` / `@effect/rpc` → `effect/unstable/cluster` / `effect/unstable/rpc`

Only affects `src/cluster/` directory:

- `src/cluster/to-entity.ts` — `Entity` from `@effect/cluster`, `Rpc` from `@effect/rpc`
- `src/cluster/entity-machine.ts` — same

### 13. `Layer.unwrapEffect` → `Layer.unwrap`

Check if used in actor system or persistence layers.

### 14. `Schedule.driver` → check v4 API

Used in `src/persistence/persistent-actor.ts` for snapshot scheduling.

### 15. `Brand.Brand` → check v4 API

Used in `src/internal/brands.ts`. `Brand` module may have changed.

## Files Summary

| File                                    | Changes needed                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/actor.ts`                          | Context.GenericTag, catchAll, catchAllCause, fork, forkDaemon, serviceOption, void |
| `src/slot.ts`                           | Context.GenericTag                                                                 |
| `src/machine.ts`                        | Context.Tag cast, serviceOptional, serviceOption, Cause.isInterruptedOnly          |
| `src/errors.ts`                         | TaggedError → TaggedErrorClass (8 classes)                                         |
| `src/schema.ts`                         | Schema.Union syntax, possibly Literal syntax, TaggedStruct check                   |
| `src/inspection.ts`                     | Context.GenericTag                                                                 |
| `src/testing.ts`                        | catchAll, void, fork                                                               |
| `src/persistence/adapter.ts`            | Context.Tag class, TaggedError (2 classes)                                         |
| `src/persistence/persistent-actor.ts`   | catchAll, catchAllCause, fork, Schedule.driver, void                               |
| `src/persistence/adapters/in-memory.ts` | Check Schema usage                                                                 |
| `src/cluster/to-entity.ts`              | @effect/cluster → effect/unstable/cluster, @effect/rpc → effect/unstable/rpc       |
| `src/cluster/entity-machine.ts`         | Same cluster/rpc import changes                                                    |
| `src/internal/brands.ts`                | Brand.Brand check                                                                  |
| `src/internal/transition.ts`            | Check Effect usage                                                                 |
| `src/internal/utils.ts`                 | EffectTypeId check (may have changed)                                              |
| `src/internal/inspection.ts`            | Likely no changes                                                                  |

## Execution Order

1. Create `src-v4/` as copy of `src/`
2. In `src-v4/`: fix all `Context.Tag`/`GenericTag` → `ServiceMap.Service`
3. Fix `Schema.TaggedError` → `Schema.TaggedErrorClass`
4. Fix `Effect.catchAll` → `catchEager`, `catchAllCause` → `catchCause`
5. Fix `Effect.void`, `fork` → `forkChild`, `forkDaemon` → `forkDetach`
6. Fix `Schema.Union`/`Literal` syntax changes
7. Fix `@effect/cluster`/`@effect/rpc` imports in cluster/
8. Fix `Layer.unwrapEffect` → `Layer.unwrap`
9. Verify `Effect.serviceOptional`/`Effect.serviceOption` v4 equivalents
10. Verify `Schedule.driver`, `Brand.Brand`, `Cause.isInterruptedOnly`
11. Set up dual tsconfig and build for v4
12. Typecheck + test

## Risk Assessment

- **Low-medium complexity** — ~16 source files, most changes mechanical
- **Cluster module** is the riskiest — depends on `@effect/cluster` + `@effect/rpc` which moved to unstable
- **`Effect.serviceOptional`** — needs careful checking, used for slot resolution in the core machine loop
- **`EffectTypeId`** — used in `isEffect` guard in `internal/utils.ts`, may have changed in v4 internals
- **Schedule.driver** — used for persistent snapshot scheduling, verify v4 API
