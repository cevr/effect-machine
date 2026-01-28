// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, TestClock } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  Slot,
  State,
} from "../../src/index.js";
import { describe, expect, it, yieldFibers } from "../utils/effect-test.js";

describe("Timeout Transitions via Spawn", () => {
  const NotifState = State({
    Showing: { message: Schema.String },
    Dismissed: {},
  });
  type NotifState = typeof NotifState.Type;

  const NotifEvent = Event({
    Dismiss: {},
  });
  type NotifEvent = typeof NotifEvent.Type;

  const NotifEffects = Slot.Effects({
    scheduleAutoDismiss: {},
  });

  it.scoped("schedules event after duration with TestClock", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        effects: NotifEffects,
        initial: NotifState.Showing({ message: "Hello" }),
      })
        .on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed)
        .spawn(NotifState.Showing, ({ effects }) => effects.scheduleAutoDismiss())
        .provide({
          scheduleAutoDismiss: (_, { self }) =>
            Effect.sleep("3 seconds").pipe(Effect.andThen(self.send(NotifEvent.Dismiss))),
        })
        .final(NotifState.Dismissed);

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

  it.scoped("cancels timer on state exit before timeout", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        effects: NotifEffects,
        initial: NotifState.Showing({ message: "Hello" }),
      })
        .on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed)
        .spawn(NotifState.Showing, ({ effects }) => effects.scheduleAutoDismiss())
        .provide({
          scheduleAutoDismiss: (_, { self }) =>
            Effect.sleep("3 seconds").pipe(Effect.andThen(self.send(NotifEvent.Dismiss))),
        })
        .final(NotifState.Dismissed);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("notification", machine);

      // Manual dismiss before timer
      yield* actor.send(NotifEvent.Dismiss);
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
