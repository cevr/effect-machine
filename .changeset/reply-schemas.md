---
"effect-machine": minor
---

feat: add typed reply schemas for ask()

- `Event.reply(fields, schema)` — declare reply-bearing events with schema validation
- `Machine.reply(state, value)` — branded helper replacing duck-typed `{ state, reply }`
- `actor.ask(event)` — infers return type from event's reply schema; non-reply events are type errors
- Runtime validation: reply values decoded through schema; decode failure = defect
- Entity-machine: `Ask` RPC propagates replies through cluster boundary
- Backported to v3
