// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "./utils/effect-test.js";

const TestState = State({
  Idle: {},
  Active: { value: Schema.Number },
  Done: {},
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Start: { value: Schema.Number },
  Update: { value: Schema.Number },
  Stop: {},
});
type TestEvent = typeof TestEvent.Type;

describe("ActorSystem", () => {
  it.scopedLive("spawns actors and processes events", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Update, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
        .final(TestState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test-actor", machine);

      yield* actor.send(TestEvent.Start({ value: 10 }));
      yield* yieldFibers;

      const state1 = yield* actor.state.get;
      expect(state1._tag).toBe("Active");

      yield* actor.send(TestEvent.Update({ value: 20 }));
      yield* yieldFibers;

      const state2 = yield* actor.state.get;
      expect(state2._tag).toBe("Active");
      if (state2._tag === "Active") {
        expect(state2.value).toBe(20);
      }

      yield* actor.send(TestEvent.Stop);
      yield* yieldFibers;

      const state3 = yield* actor.state.get;
      expect(state3._tag).toBe("Done");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("stops actors properly", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Active({ value: event.value }),
      );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test-actor", machine);

      yield* actor.send(TestEvent.Start({ value: 5 }));
      yield* yieldFibers;

      // Verify actor is in expected state before stopping
      const stateBeforeStop = yield* actor.snapshot;
      expect(stateBeforeStop._tag).toBe("Active");

      yield* system.stop("test-actor");

      // Verify actor is no longer in system
      const actorAfterStop = yield* system.get("test-actor");
      expect(actorAfterStop._tag).toBe("None");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
