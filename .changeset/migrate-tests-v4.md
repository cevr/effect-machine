---
"effect-machine": patch
---

Migrate test suite to Effect v4

- Update effect-bun-test to v0.2.0 (v4-compatible)
- Migrate all 19 test files to v4 APIs (Effect, Schema, SubscriptionRef, ServiceMap)
- Fix MachineStateSchema/MachineEventSchema types to use Schema.Codec for encode/decode compat
- Disable oxlint import/namespace rule (false positives on type-only Brand imports)
- Update MIGRATION-GUIDE.md with new findings and bulk migration strategy
