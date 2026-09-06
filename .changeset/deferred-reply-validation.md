---
"effect-machine": patch
---

Validate deferred `Machine.deferReply` values with the event reply schema before settling `ActorRef.ask`. If state exit interrupts reply decoding, settle the waiting caller with that interruption instead of leaving it pending.
