---
"effect-machine": minor
---

Rename `derive` to `with` on state/event schemas. Union-level `with` accepts shared fields without casts on generic type parameters. Add `.schema` (branded) accessor to `MachineStateSchema`. Remove `.plain` — use constructors in tests instead of raw object literals. Add `Slot.of(slotsSchema, provided)` to convert `ProvideSlots` into `SlotCalls` without consumer-side casts.
