---
"effect-machine": minor
---

Cold spawn + Recovery/Durability lifecycle API (v3 backport).

**Breaking changes:**

- `Machine.spawn` now returns an **unstarted** actor. Call `yield* actor.start` to fork the event loop, background effects, and spawn effects. Events sent before `start()` are queued.
- `system.spawn` auto-starts — no change needed for registry-based spawns.
- `PersistConfig<S>` is removed. Use `Lifecycle<S, E>` instead.

**New APIs:**

- `ActorRef.start` — idempotent Effect that starts the actor
- `Recovery<S>` — resolves initial state per generation during `actor.start`
- `RecoveryContext<S>` — `{ actorId, generation, machineInitial }`
- `Durability<S, E>` — saves state after committed transitions
- `DurabilityCommit<S, E>` — `{ actorId, generation, previousState, nextState, event }`
- `Lifecycle<S, E>` — `{ recovery?, durability? }`

**Migration from `PersistConfig`:**

```ts
// Before (PersistConfig)
Machine.spawn(machine, {
  persist: {
    load: () => storage.get(key),
    save: (state) => storage.set(key, state),
    shouldSave: (state, prev) => state._tag !== prev._tag,
    onRestore: (state, { initial }) => validate(state),
  },
});

// After (Lifecycle)
const actor =
  yield *
  Machine.spawn(machine, {
    lifecycle: {
      recovery: {
        // Replaces load() + onRestore() — single callback
        resolve: ({ actorId, generation, machineInitial }) =>
          storage.get(key).pipe(
            Effect.map(Option.fromNullable),
            // Do any validation/migration here
          ),
      },
      durability: {
        // Receives full commit context, not just the new state
        save: ({ actorId, generation, previousState, nextState, event }) =>
          storage.set(key, nextState),
        shouldSave: (state, prev) => state._tag !== prev._tag,
      },
    },
  });
yield * actor.start; // NEW: explicit start required
```

**Key differences from `PersistConfig`:**

- `Recovery.resolve` merges `load()` + `onRestore()` into one callback
- `Recovery.resolve` receives `RecoveryContext` with `actorId`, `generation` (0 = cold start, 1+ = supervision restart), and `machineInitial`
- `Durability.save` receives `DurabilityCommit` with full transition context (previous state, next state, event, generation)
- Recovery runs during `actor.start`, not during allocation
- `hydrate` option overrides recovery entirely (resolve is never called)
