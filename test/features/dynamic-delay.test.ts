// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Duration, Effect, Schema, TestClock } from "effect";

import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "../../src/index.js";
import { describe, expect, it, yieldFibers } from "../utils/effect-test.js";

describe("Dynamic Delay Duration", () => {
  const WaitState = State({
    Waiting: { timeout: Schema.Number },
    TimedOut: {},
  });
  type WaitState = typeof WaitState.Type;

  const WaitEvent = Event({
    Timeout: {},
  });
  type WaitEvent = typeof WaitEvent.Type;

  it.scoped("dynamic duration computed from state", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WaitState,
        event: WaitEvent,
        initial: WaitState.Waiting({ timeout: 5 }),
      }).pipe(
        Machine.on(WaitState.Waiting, WaitEvent.Timeout, () => WaitState.TimedOut()),
        Machine.delay(
          WaitState.Waiting,
          (state) => Duration.seconds(state.timeout),
          WaitEvent.Timeout(),
        ),
        Machine.final(WaitState.TimedOut),
      );

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
      type RetryEvent = typeof RetryEvent.Type;

      const machine = Machine.make({
        state: RetryState,
        event: RetryEvent,
        initial: RetryState.Retrying({ attempt: 1, backoff: 1 }),
      }).pipe(
        Machine.on.force(RetryState.Retrying, RetryEvent.Retry, ({ state }) =>
          RetryState.Retrying({ attempt: state.attempt + 1, backoff: state.backoff * 2 }),
        ),
        Machine.on(RetryState.Retrying, RetryEvent.GiveUp, () => RetryState.Failed()),
        // Exponential backoff based on state
        Machine.delay(
          RetryState.Retrying,
          (state) => Duration.seconds(state.backoff),
          RetryEvent.GiveUp(),
        ),
        Machine.final(RetryState.Failed),
      );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("retry", machine);

      // First attempt - 1 second backoff timer starts
      let current = yield* actor.state.get;
      expect(current._tag).toBe("Retrying");
      expect((current as RetryState & { _tag: "Retrying" }).backoff).toBe(1);

      // Advance 0.5 seconds, then manual retry (cancels old timer, starts new with 2s)
      yield* TestClock.adjust("500 millis");
      yield* actor.send(RetryEvent.Retry());
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
        initial: WaitState.Waiting({ timeout: 999 }),
      }).pipe(
        Machine.on(WaitState.Waiting, WaitEvent.Timeout, () => WaitState.TimedOut()),
        // Static "3 seconds" ignores state.timeout
        Machine.delay(WaitState.Waiting, "3 seconds", WaitEvent.Timeout()),
        Machine.final(WaitState.TimedOut),
      );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("waiter", machine);

      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      const current = yield* actor.state.get;
      expect(current._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
