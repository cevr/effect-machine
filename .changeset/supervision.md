---
"effect-machine": minor
---

Add actor supervision with automatic restart on defect.

**New APIs:**

- `Supervision.restart({ maxRestarts, within, backoff })` — Schedule-based restart policy
- `Supervision.none` — no supervision (default, crashes are terminal)
- `actor.awaitExit` — resolves with `ActorExit<S>` when actor terminally stops
- `actor.watch(other)` — now returns `ActorExit<unknown>` (breaking, pre-1.0)

**New types:**

- `ActorExit<S>` — `Final { state }` | `Stopped` | `Defect { cause, phase }`
- `DefectPhase` — `"transition"` | `"spawn"` | `"background"` | `"initial-spawn"`
- `Supervision.Policy` — Schedule-based restart policy interface

**Usage:**

```ts
import { Machine, Supervision } from "effect-machine";

const actor =
  yield *
  Machine.spawn(machine, {
    supervision: Supervision.restart({ maxRestarts: 3, within: "1 minute" }),
  });

const exit = yield * actor.awaitExit; // ActorExit<S>
```

**Breaking changes (pre-1.0):**

- `watch()` returns `Effect<ActorExit<unknown>>` instead of `Effect<void>`
- `SystemEvent.ActorStopped` gains `exit: ActorExit<unknown>` field
- New `SystemEvent.ActorRestarted` variant

**Internal:**

- Runtime kernel split: cell-owned resources, actorScope, exitDeferred
- Background/spawn/transition defect detection with DefectPhase tagging
- Generation owner fiber for actorScope lifecycle
- `Effect.runForkWith` for proper service propagation (v4)
- `globalXInEffect` diagnostics enabled in tsconfig
