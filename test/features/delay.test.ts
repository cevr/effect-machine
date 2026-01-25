import { Data, Effect, Layer, pipe, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  build,
  delay,
  final,
  make,
  on,
  yieldFibers,
} from "../../src/index.js";

describe("Delay Transitions", () => {
  type State = Data.TaggedEnum<{
    Showing: { message: string };
    Dismissed: {};
  }>;
  const State = Data.taggedEnum<State>();

  type Event = Data.TaggedEnum<{
    Dismiss: {};
  }>;
  const Event = Data.taggedEnum<Event>();

  test("schedules event after duration with TestClock", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Showing({ message: "Hello" })),
            on(State.Showing, Event.Dismiss, () => State.Dismissed()),
            delay(State.Showing, "3 seconds", Event.Dismiss()),
            final(State.Dismissed),
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
        const machine = build(
          pipe(
            make<State, Event>(State.Showing({ message: "Hello" })),
            on(State.Showing, Event.Dismiss, () => State.Dismissed()),
            delay(State.Showing, "3 seconds", Event.Dismiss()),
            final(State.Dismissed),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("notification", machine);

        // Manual dismiss before timer
        yield* actor.send(Event.Dismiss());
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
