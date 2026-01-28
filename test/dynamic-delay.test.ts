// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Duration, Effect, Schema, TestClock } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  Slot,
  State,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "./utils/effect-test.js";

describe("Dynamic Timeout Duration via Spawn", () => {
  const WaitState = State({
    Waiting: { timeout: Schema.Number },
    TimedOut: {},
  });
  type WaitState = typeof WaitState.Type;

  const WaitEvent = Event({
    Timeout: {},
  });

  const WaitEffects = Slot.Effects({
    scheduleTimeout: {},
  });

  it.scoped("dynamic duration computed from state", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WaitState,
        event: WaitEvent,
        effects: WaitEffects,
        initial: WaitState.Waiting({ timeout: 5 }),
      })
        .on(WaitState.Waiting, WaitEvent.Timeout, () => WaitState.TimedOut)
        .spawn(WaitState.Waiting, ({ effects }) => effects.scheduleTimeout())
        .provide({
          scheduleTimeout: (_, { self, state }) => {
            const s = state as WaitState & { _tag: "Waiting" };
            return Effect.sleep(Duration.seconds(s.timeout)).pipe(
              Effect.andThen(self.send(WaitEvent.Timeout)),
            );
          },
        })
        .final(WaitState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("waiter", machine);

      // Initial state
      let current = yield* actor.state.get;
      expect(current._tag).toBe("Waiting");

      // Advance 3 seconds - not enough
      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      current = yield* actor.state.get;
      expect(current._tag).toBe("Waiting");

      // Advance 2 more seconds (5 total) - should timeout
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;

      current = yield* actor.state.get;
      expect(current._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("dynamic duration with different state values", () =>
    Effect.gen(function* () {
      const RetryState = State({
        Retrying: { attempt: Schema.Number, backoff: Schema.Number },
        Failed: {},
        Success: {},
      });
      type RetryState = typeof RetryState.Type;

      const RetryEvent = Event({
        Retry: {},
        GiveUp: {},
      });

      const RetryEffects = Slot.Effects({
        scheduleGiveUp: {},
      });

      const machine = Machine.make({
        state: RetryState,
        event: RetryEvent,
        effects: RetryEffects,
        initial: RetryState.Retrying({ attempt: 1, backoff: 1 }),
      })
        .reenter(RetryState.Retrying, RetryEvent.Retry, ({ state }) =>
          RetryState.Retrying({ attempt: state.attempt + 1, backoff: state.backoff * 2 }),
        )
        .on(RetryState.Retrying, RetryEvent.GiveUp, () => RetryState.Failed)
        // Exponential backoff based on state
        .spawn(RetryState.Retrying, ({ effects }) => effects.scheduleGiveUp())
        .provide({
          scheduleGiveUp: (_, { self, state }) => {
            const s = state as RetryState & { _tag: "Retrying" };
            return Effect.sleep(Duration.seconds(s.backoff)).pipe(
              Effect.andThen(self.send(RetryEvent.GiveUp)),
            );
          },
        })
        .final(RetryState.Failed);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("retry", machine);

      // First attempt - 1 second backoff timer starts
      let current = yield* actor.state.get;
      expect(current._tag).toBe("Retrying");
      expect((current as RetryState & { _tag: "Retrying" }).backoff).toBe(1);

      // Advance 0.5 seconds, then manual retry (cancels old timer, starts new with 2s)
      yield* TestClock.adjust("500 millis");
      yield* actor.send(RetryEvent.Retry);
      yield* yieldFibers;

      // Now backoff is 2 seconds, new timer started
      current = yield* actor.state.get;
      expect((current as RetryState & { _tag: "Retrying" }).backoff).toBe(2);

      // Wait 1.5 seconds - should still be retrying (need 2s for new timer)
      yield* TestClock.adjust("1500 millis");
      yield* yieldFibers;
      current = yield* actor.state.get;
      expect(current._tag).toBe("Retrying");

      // Wait 0.5 more seconds (2 total from retry) - should give up
      yield* TestClock.adjust("500 millis");
      yield* yieldFibers;
      current = yield* actor.state.get;
      expect(current._tag).toBe("Failed");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("static duration still works", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WaitState,
        event: WaitEvent,
        effects: WaitEffects,
        initial: WaitState.Waiting({ timeout: 999 }),
      })
        .on(WaitState.Waiting, WaitEvent.Timeout, () => WaitState.TimedOut)
        // Static "3 seconds" ignores state.timeout
        .spawn(WaitState.Waiting, ({ effects }) => effects.scheduleTimeout())
        .provide({
          scheduleTimeout: (_, { self }) =>
            Effect.sleep("3 seconds").pipe(Effect.andThen(self.send(WaitEvent.Timeout))),
        })
        .final(WaitState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("waiter", machine);

      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      const current = yield* actor.state.get;
      expect(current._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
