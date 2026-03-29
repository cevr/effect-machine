---
"effect-machine": minor
---

Unified slot system redesign + local persistence + slot schemas.

**Breaking changes (pre-1.0):**

- `Slot.Guards` / `Slot.Effects` replaced by `Slot.define` + `Slot.fn`
- `guards:` / `effects:` on `Machine.make` replaced by single `slots:` field
- Slot handlers take only params — no ctx parameter. Use `yield* machine.Context` for machine state.
- `HandlerContext.guards` / `HandlerContext.effects` replaced by `HandlerContext.slots`
- `StateHandlerContext.effects` replaced by `StateHandlerContext.slots`
- Removed: `SlotContext`, `GuardsDef`, `EffectsDef`, `GuardSlot`, `EffectSlot`, `GuardHandlers`, `EffectHandlers`, `HasGuardKeys`, `HasEffectKeys`
- `SlotProvisionError.slotType` is now `"slot"` only (was `"guard" | "effect" | "slot"`)
- `Machine.spawn` `slots` option is now `ProvideSlots<SD>` (type-checked, was `Record<string, any>`)

**New APIs:**

- `Slot.fn(fields, returnSchema?)` — define a slot with typed params and arbitrary return type
- `Slot.define({ ... })` — create a slots schema from slot definitions
- `SlotFnDef.inputSchema` / `outputSchema` — materialized schemas for runtime validation and serialization
- `SlotsSchema.requestSchema` / `resultSchema` / `invocationSchema` — wire-format schemas for RPC and persistence
- `slotValidation` option on `Machine.make` — runtime input/output validation (default: true)
- `SlotCodecError` — tagged error for validation failures (raised as defect)
- `PersistConfig<S>` — local persistence for `Machine.spawn`:
  - `load()` → hydrate from storage
  - `save(state)` → save after transitions
  - `shouldSave?(state, prev)` → filter saves
  - `onRestore?(state, { initial })` → recovery decision hook
- `ActorSystem.spawn` now accepts `slots` and `persist` options
- Multi-state `.spawn()` and `.task()` overloads (array of states)
- `.task()` shorthand — omit `onSuccess` when task returns Event directly

**Internal:**

- `resolveActorSystem()` and `runSupervisionLoop()` extracted from `createActor`
- `Queue.clear` replaces manual poll loop for shutdown drain
- Plain-object return bug fixed in slot resolve (uses `Effect.isEffect`)
- `materializeMachine` threads `_slotValidation` through copies
