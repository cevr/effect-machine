// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Duration, Effect, Schema } from "effect";

import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test/v3";

// ============================================================================
// Fixtures
// ============================================================================

const S = State({ Idle: {}, Active: { count: Schema.Number }, Done: {} });
type S = typeof S.Type;

const E = Event({ Start: { count: Schema.Number }, Increment: {}, Finish: {} });
type E = typeof E.Type;

const machine = Machine.make({ state: S, event: E, initial: S.Idle })
  .on(S.Idle, E.Start, ({ event }) => S.Active({ count: event.count }))
  .on(S.Active, E.Increment, ({ state }) => S.Active({ count: state.count + 1 }))
  .on(S.Active, E.Finish, () => S.Done)
  .final(S.Done);

// ============================================================================
// actor.watch — observe when another actor stops
// ============================================================================

describe("actor.watch", () => {
  it.scopedLive("completes when watched actor is stopped", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const watcher = yield* system.spawn("watcher", machine);
      const target = yield* system.spawn("target", machine);

      const watchDone = yield* Deferred.make<void>();
      yield* Effect.forkDaemon(
        watcher.watch(target).pipe(Effect.andThen(Deferred.succeed(watchDone, undefined))),
      );
      yield* Effect.yieldNow();
      yield* yieldFibers;

      yield* system.stop("target");
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));
      yield* yieldFibers;

      expect(yield* Deferred.isDone(watchDone)).toBe(true);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("completes immediately for already-stopped actor", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const watcher = yield* system.spawn("watcher", machine);
      const target = yield* system.spawn("target", machine);

      yield* system.stop("target");
      yield* Effect.yieldNow();
      yield* yieldFibers;

      const watchDone = yield* Deferred.make<void>();
      yield* Effect.forkDaemon(
        watcher.watch(target).pipe(Effect.andThen(Deferred.succeed(watchDone, undefined))),
      );
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));
      yield* yieldFibers;

      expect(yield* Deferred.isDone(watchDone)).toBe(true);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

// ============================================================================
// actor.drain — process remaining queue, then stop
// ============================================================================

describe("actor.drain", () => {
  it.scopedLive("stops cleanly after all events are processed", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);

      // Send events and let them process
      yield* actor.send(E.Start({ count: 0 }));
      yield* actor.send(E.Increment);
      yield* actor.send(E.Increment);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
      if (state._tag === "Active") {
        expect(state.count).toBe(2);
      }

      // Drain: enqueues a sentinel that processes after any remaining events,
      // then shuts down the actor cleanly
      yield* actor.drain;

      // After drain, actor is stopped
      const stoppedState = yield* actor.snapshot;
      expect(stoppedState._tag).toBe("Active");
    }),
  );

  it.scopedLive("is no-op on already-stopped actor", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.stop;
      yield* yieldFibers;
      yield* actor.drain;
    }),
  );
});
