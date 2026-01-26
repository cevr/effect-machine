// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

describe("Delay Transitions", () => {
  type NotifState = State.TaggedEnum<{
    Showing: { message: string };
    Dismissed: {};
  }>;
  const NotifState = State.taggedEnum<NotifState>();

  type NotifEvent = Event.TaggedEnum<{
    Dismiss: {};
  }>;
  const NotifEvent = Event.taggedEnum<NotifEvent>();

  test("schedules event after duration with TestClock", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<NotifState, NotifEvent>(NotifState.Showing({ message: "Hello" })).pipe(
            Machine.on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed()),
            Machine.delay(NotifState.Showing, "3 seconds", NotifEvent.Dismiss()),
            Machine.final(NotifState.Dismissed),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("notification", machine);

        // Initial state
        let current = yield* actor.state.get;
        expect(current._tag).toBe("Showing");

        // Advance time by 3 seconds
        yield* TestClock.adjust("3 seconds");

        // Allow fibers to run
        yield* yieldFibers;

        // Should have transitioned
        current = yield* actor.state.get;
        expect(current._tag).toBe("Dismissed");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("cancels timer on state exit before delay", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<NotifState, NotifEvent>(NotifState.Showing({ message: "Hello" })).pipe(
            Machine.on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed()),
            Machine.delay(NotifState.Showing, "3 seconds", NotifEvent.Dismiss()),
            Machine.final(NotifState.Dismissed),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("notification", machine);

        // Manual dismiss before timer
        yield* actor.send(NotifEvent.Dismiss());
        yield* yieldFibers;

        let current = yield* actor.state.get;
        expect(current._tag).toBe("Dismissed");

        // Advance time - should not cause issues since timer was cancelled
        yield* TestClock.adjust("5 seconds");
        yield* yieldFibers;

        current = yield* actor.state.get;
        expect(current._tag).toBe("Dismissed");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });
});
