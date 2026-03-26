---
"effect-machine": minor
---

Backport all v4 features to Effect v3 variant + restructure into `v3/` directory

**Restructure:**

- `src-v3/` → `v3/src/`, `tsconfig.v3.json` → `v3/tsconfig.json`, `tsdown.v3.config.ts` → `v3/tsdown.config.ts`
- Added `v3/test/` with full test suite (248 tests)
- Package exports unchanged: `effect-machine/v3`, `effect-machine/v3/cluster`

**Features backported from v4:**

- `call()` — serialized request-reply (OTP gen_server:call)
- `cast()` — fire-and-forget alias for send (OTP gen_server:cast)
- `ask()` — typed domain reply from handler's `{ state, reply }` return
- `ActorRef.sync` namespace — replaces flat `sendSync`/`stopSync`/`snapshotSync`/`matchesSync`/`canSync`
- `.timeout()` builder — gen_statem-style state timeouts
- `.postpone()` builder — gen_statem-style event postpone with drain-until-stable
- `hasReply` structural flag on `ProcessEventResult`
- `ActorStoppedError` / `NoReplyError` error types
- `makeInspectorEffect` / `combineInspectors` / `tracingInspector` inspection helpers
- `actorId` threaded through all handler contexts

**Bug fix:**

- `State.derive()` now guards against `_tag` override in partial argument
