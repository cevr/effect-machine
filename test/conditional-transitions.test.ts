// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { Event, Machine, simulate, State } from "../src/index.js";

describe("Conditional Transitions (replaces choose combinator)", () => {
  it.scopedLive("first matching guard wins", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: { value: Schema.Finite },
        High: {},
        Medium: {},
        Low: {},
      });

      const TestEvent = Event({
        Check: {},
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 75 }),
      })
        .on(TestState.Idle, TestEvent.Check, ({ state }) => {
          if (state.value >= 70) {
            return TestState.High;
          }
          if (state.value >= 40) {
            return TestState.Medium;
          }
          return TestState.Low;
        })
        .final(TestState.High)
        .final(TestState.Medium)
        .final(TestState.Low);

      const result = yield* simulate(machine, [TestEvent.Check]);
      expect(result.finalState._tag).toBe("High");
    }),
  );

  it.scopedLive("fallback branch catches all", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: { value: Schema.Finite },
        High: {},
        Low: {},
      });

      const TestEvent = Event({
        Check: {},
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 10 }),
      })
        .on(TestState.Idle, TestEvent.Check, ({ state }) => {
          if (state.value >= 70) return TestState.High;
          return TestState.Low;
        })
        .final(TestState.High)
        .final(TestState.Low);

      const result = yield* simulate(machine, [TestEvent.Check]);
      expect(result.finalState._tag).toBe("Low");
    }),
  );

  it.scopedLive("accepts an Effect result in a matching branch", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: {},
        Done: {},
      });

      const TestEvent = Event({
        Go: {},
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Go, () => Effect.succeed(TestState.Done))
        .final(TestState.Done);

      const result = yield* simulate(machine, [TestEvent.Go]);
      expect(result.finalState).toEqual(TestState.Done);
    }),
  );
});
