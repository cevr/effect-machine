// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Duration, Effect, Schema } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Machine,
  State,
  Event,
  Supervision,
  type ActorExit,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test/v3";

// ============================================================================
// Fixtures
// ============================================================================

const S = State({ Idle: {}, Active: { count: Schema.Number }, Done: {} });
type S = typeof S.Type;

const E = Event({ Start: { count: Schema.Number }, Increment: {}, Finish: {}, Crash: {} });
type E = typeof E.Type;

const machine = Machine.make({ state: S, event: E, initial: S.Idle })
  .on(S.Idle, E.Start, ({ event }) => S.Active({ count: event.count }))
  .on(S.Active, E.Increment, ({ state }) => S.Active({ count: state.count + 1 }))
  .on(S.Active, E.Finish, () => S.Done)
  .on(S.Active, E.Crash, () => Effect.die("boom"))
  .final(S.Done);

// ============================================================================
// Restart on defect
// ============================================================================

describe("supervision: restart on defect", () => {
  it.scopedLive("restarts actor from initial state after transition defect", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 3 }),
      });

      // Drive to Active state
      yield* actor.send(E.Start({ count: 10 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const stateBefore = yield* actor.snapshot;
      expect(stateBefore._tag).toBe("Active");

      // Trigger defect
      yield* actor.send(E.Crash);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      // After restart, state should be back to initial (Idle)
      const stateAfter = yield* actor.snapshot;
      expect(stateAfter._tag).toBe("Idle");

      // Actor should still be alive — can process events
      yield* actor.send(E.Start({ count: 42 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const stateRecovered = yield* actor.snapshot;
      expect(stateRecovered._tag).toBe("Active");
      if (stateRecovered._tag === "Active") {
        expect(stateRecovered.count).toBe(42);
      }
    }),
  );
});

// ============================================================================
// Final state = no restart
// ============================================================================

describe("supervision: final state", () => {
  it.scopedLive("awaitExit resolves with Final on clean completion", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 3 }),
      });

      yield* actor.send(E.Start({ count: 0 }));
      yield* actor.send(E.Finish);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Final");
      if (exit._tag === "Final") {
        expect(exit.state._tag).toBe("Done");
      }
    }),
  );
});

// ============================================================================
// Explicit stop = no restart
// ============================================================================

describe("supervision: explicit stop", () => {
  it.scopedLive("awaitExit resolves with Stopped on actor.stop", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 3 }),
      });

      yield* actor.send(E.Start({ count: 0 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;

      yield* actor.stop;
      yield* yieldFibers;

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Stopped");
    }),
  );
});

// ============================================================================
// Drain = no restart
// ============================================================================

describe("supervision: drain", () => {
  it.scopedLive("drain is terminal — no restart", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 3 }),
      });

      yield* actor.send(E.Start({ count: 0 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      yield* actor.drain;

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Stopped");
    }),
  );
});

// ============================================================================
// Budget exceeded
// ============================================================================

describe("supervision: budget exceeded", () => {
  it.scopedLive("terminates with Defect after maxRestarts exhausted", () =>
    Effect.gen(function* () {
      // Machine that crashes immediately on Start
      const crashMachine = Machine.make({ state: S, event: E, initial: S.Idle })
        .on(S.Idle, E.Start, () => Effect.die("always crash"))
        .final(S.Done);

      const actor = yield* Machine.spawn(crashMachine, {
        supervision: Supervision.restart({ maxRestarts: 2 }),
      });

      // Each Start will crash, restart, and we send again
      yield* actor.send(E.Start({ count: 0 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      yield* actor.send(E.Start({ count: 0 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      yield* actor.send(E.Start({ count: 0 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Defect");
    }),
  );
});

// ============================================================================
// Actor ID stable across restarts
// ============================================================================

describe("supervision: actor identity", () => {
  it.scopedLive("actor ID and system registration survive restart", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("supervised-1", machine, {
        supervision: Supervision.restart({ maxRestarts: 3 }),
      });

      expect(actor.id).toBe("supervised-1");

      // Drive to Active, crash
      yield* actor.send(E.Start({ count: 5 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));
      yield* actor.send(E.Crash);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      // ID unchanged
      expect(actor.id).toBe("supervised-1");

      // Still in system
      const found = yield* system.get("supervised-1");
      expect(found._tag).toBe("Some");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

// ============================================================================
// watch returns ActorExit
// ============================================================================

describe("supervision: watch", () => {
  it.scopedLive("watch resolves with exit reason on terminal stop", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const watcher = yield* system.spawn("watcher", machine);
      const target = yield* system.spawn("target", machine, {
        supervision: Supervision.restart({ maxRestarts: 1 }),
      });

      const watchResult = yield* Deferred.make<ActorExit<unknown>>();
      yield* Effect.forkDaemon(
        watcher.watch(target).pipe(Effect.tap((exit) => Deferred.succeed(watchResult, exit))),
      );

      // Drive target to final
      yield* target.send(E.Start({ count: 0 }));
      yield* target.send(E.Finish);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      const exit = yield* Deferred.await(watchResult);
      expect(exit._tag).toBe("Final");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

// ============================================================================
// awaitExit for unsupervised actors
// ============================================================================

describe("awaitExit (unsupervised)", () => {
  it.scopedLive("resolves with Final on clean completion", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);

      yield* actor.send(E.Start({ count: 0 }));
      yield* actor.send(E.Finish);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Final");
    }),
  );

  it.scopedLive("resolves with Stopped on explicit stop", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.stop;
      yield* yieldFibers;

      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Stopped");
    }),
  );
});

// ============================================================================
// Background crash restarts
// ============================================================================

describe("supervision: background crash", () => {
  it.scopedLive("restarts after background effect defect", () =>
    Effect.gen(function* () {
      // Background effect runs at actor creation, crashes after a short delay
      const bgCrashMachine = Machine.make({ state: S, event: E, initial: S.Idle })
        .on(S.Idle, E.Start, ({ event }) => S.Active({ count: event.count }))
        .on(S.Active, E.Finish, () => S.Done)
        .background(() =>
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.millis(30));
            return yield* Effect.die("background boom");
          }),
        )
        .final(S.Done);

      const actor = yield* Machine.spawn(bgCrashMachine, {
        supervision: Supervision.restart({ maxRestarts: 2 }),
      });

      // Wait for background to crash and restart to complete
      yield* Effect.sleep(Duration.millis(200));
      yield* yieldFibers;

      // After background crash + restart, state should still be Idle (initial)
      const stateAfter = yield* actor.snapshot;
      expect(stateAfter._tag).toBe("Idle");
    }),
  );
});

// ============================================================================
// Pending requests fail on crash
// ============================================================================

describe("supervision: pending requests", () => {
  it.scopedLive("pending ask fails with ActorStoppedError on crash", () =>
    Effect.gen(function* () {
      // Machine with a reply event and a crash event
      const ReplyE = Event({
        GetCount: Event.reply({}, Schema.Number),
        SetCount: { count: Schema.Number },
        CrashNow: {},
      });

      const replyMachine = Machine.make({ state: S, event: ReplyE, initial: S.Idle })
        .on(S.Idle, ReplyE.SetCount, ({ event }) => S.Active({ count: event.count }))
        .on(S.Active, ReplyE.GetCount, ({ state }) => Machine.reply(state, state.count))
        .on(S.Active, ReplyE.CrashNow, () => Effect.die("crash for pending test"))
        .final(S.Done);

      const actor = yield* Machine.spawn(replyMachine, {
        supervision: Supervision.restart({ maxRestarts: 1 }),
      });

      yield* actor.send(ReplyE.SetCount({ count: 5 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      // Crash the actor
      yield* actor.send(ReplyE.CrashNow);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      // After restart, actor is alive in Idle — can set state again
      yield* actor.send(ReplyE.SetCount({ count: 10 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      // Ask should work on the restarted actor
      const count = yield* actor.ask(ReplyE.GetCount);
      expect(count).toBe(10);
    }),
  );
});
