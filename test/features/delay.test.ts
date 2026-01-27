// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, TestClock } from "effect";

import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "../../src/index.js";
import { describe, expect, it, yieldFibers } from "../utils/effect-test.js";

describe("Delay Transitions", () => {
  const NotifState = State({
    Showing: { message: Schema.String },
    Dismissed: {},
  });
  type NotifState = typeof NotifState.Type;

  const NotifEvent = Event({
    Dismiss: {},
  });
  type NotifEvent = typeof NotifEvent.Type;

  it.scoped("schedules event after duration with TestClock", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        initial: NotifState.Showing({ message: "Hello" }),
      }).pipe(
        Machine.on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed()),
        Machine.delay(NotifState.Showing, "3 seconds", NotifEvent.Dismiss()),
        Machine.final(NotifState.Dismissed),
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
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("cancels timer on state exit before delay", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        initial: NotifState.Showing({ message: "Hello" }),
      }).pipe(
        Machine.on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed()),
        Machine.delay(NotifState.Showing, "3 seconds", NotifEvent.Dismiss()),
        Machine.final(NotifState.Dismissed),
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
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
