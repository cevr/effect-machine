---
"effect-machine": minor
---

Migrate to Effect v4 (4.0.0-beta.5)

- Default export now targets Effect v4 — v3 users should import from `effect-machine/v3`
- Migrate src/ and test suite to v4 APIs (Effect, Schema, SubscriptionRef, ServiceMap)
- MachineStateSchema/MachineEventSchema now use Schema.Codec for encode/decode compat
- 213 tests passing across 19 files
