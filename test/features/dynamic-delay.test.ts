// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Duration, Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import { ActorSystemDefault, ActorSystemService, Machine, yieldFibers } from "../../src/index.js";

describe("Dynamic Delay Duration", () => {
  type State = Data.TaggedEnum<{
    Waiting: { timeout: number };
    TimedOut: {};
  }>;
  const State = Data.taggedEnum<State>();

  type Event = Data.TaggedEnum<{
    Timeout: {};
  }>;
  const Event = Data.taggedEnum<Event>();

  test("dynamic duration computed from state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<State, Event>(State.Waiting({ timeout: 5 })).pipe(
            Machine.on(State.Waiting, Event.Timeout, () => State.TimedOut()),
            Machine.delay(
              State.Waiting,
              (state) => Duration.seconds(state.timeout),
              Event.Timeout(),
            ),
            Machine.final(State.TimedOut),
          ),
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
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("dynamic duration with different state values", async () => {
    type RetryState = Data.TaggedEnum<{
      Retrying: { attempt: number; backoff: number };
      Failed: {};
      Success: {};
    }>;
    const RetryState = Data.taggedEnum<RetryState>();

    type RetryEvent = Data.TaggedEnum<{
      Retry: {};
      GiveUp: {};
    }>;
    const RetryEvent = Data.taggedEnum<RetryEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<RetryState, RetryEvent>(
            RetryState.Retrying({ attempt: 1, backoff: 1 }),
          ).pipe(
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
          ),
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
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("static duration still works", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<State, Event>(State.Waiting({ timeout: 999 })).pipe(
            Machine.on(State.Waiting, Event.Timeout, () => State.TimedOut()),
            // Static "3 seconds" ignores state.timeout
            Machine.delay(State.Waiting, "3 seconds", Event.Timeout()),
            Machine.final(State.TimedOut),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("waiter", machine);

        yield* TestClock.adjust("3 seconds");
        yield* yieldFibers;

        const current = yield* actor.state.get;
        expect(current._tag).toBe("TimedOut");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });
});
