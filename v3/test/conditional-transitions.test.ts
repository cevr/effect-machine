// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import { Event, Machine, simulate, State, Slot } from "../src/index.js";
import { describe, expect, it } from "effect-bun-test/v3";

describe("Conditional Transitions (replaces choose combinator)", () => {
  it.scopedLive("first matching guard wins", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: { value: Schema.Number },
        High: {},
        Medium: {},
        Low: {},
      });

      const TestEvent = Event({
        Check: {},
      });

      const TestSlots = Slot.define({
        isHigh: Slot.fn({}, Schema.Boolean),
        isMedium: Slot.fn({}, Schema.Boolean),
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        slots: TestSlots,
        initial: TestState.Idle({ value: 75 }),
      })
        .on(TestState.Idle, TestEvent.Check, ({ slots }) =>
          Effect.gen(function* () {
            if (yield* slots.isHigh()) {
              return TestState.High;
            }
            if (yield* slots.isMedium()) {
              return TestState.Medium;
            }
            return TestState.Low;
          }),
        )
        .final(TestState.High)
        .final(TestState.Medium)
        .final(TestState.Low);

      const result = yield* simulate(machine, [TestEvent.Check], {
        slots: {
          isHigh: () =>
            Effect.gen(function* () {
              const ctx = yield* machine.Context;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s = ctx.state as any;
              return s._tag === "Idle" && s.value >= 70;
            }),
          isMedium: () =>
            Effect.gen(function* () {
              const ctx = yield* machine.Context;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s = ctx.state as any;
              return s._tag === "Idle" && s.value >= 40;
            }),
        },
      });
      expect(result.finalState._tag).toBe("High");
    }),
  );

  it.scopedLive("fallback branch catches all", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: { value: Schema.Number },
        High: {},
        Low: {},
      });

      const TestEvent = Event({
        Check: {},
      });

      const TestSlots = Slot.define({
        isHigh: Slot.fn({}, Schema.Boolean),
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        slots: TestSlots,
        initial: TestState.Idle({ value: 10 }),
      })
        .on(TestState.Idle, TestEvent.Check, ({ slots }) =>
          Effect.gen(function* () {
            if (yield* slots.isHigh()) {
              return TestState.High;
            }
            // Fallback
            return TestState.Low;
          }),
        )
        .final(TestState.High)
        .final(TestState.Low);

      const result = yield* simulate(machine, [TestEvent.Check], {
        slots: {
          isHigh: () =>
            Effect.gen(function* () {
              const ctx = yield* machine.Context;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s = ctx.state as any;
              return s._tag === "Idle" && s.value >= 70;
            }),
        },
      });
      expect(result.finalState._tag).toBe("Low");
    }),
  );

  it.scopedLive("runs effect in matching branch", () =>
    Effect.gen(function* () {
      const TestState = State({
        Idle: {},
        Done: {},
      });

      const TestEvent = Event({
        Go: {},
      });

      const TestSlots = Slot.define({
        logAction: Slot.fn({ message: Schema.String }),
      });

      const logs: string[] = [];

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        slots: TestSlots,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Go, ({ slots }) =>
          Effect.gen(function* () {
            yield* slots.logAction({ message: "effect ran" });
            return TestState.Done;
          }),
        )
        .final(TestState.Done);

      yield* simulate(machine, [TestEvent.Go], {
        slots: {
          logAction: ({ message }: { message: string }) =>
            Effect.sync(() => {
              logs.push(message);
            }),
        },
      });
      expect(logs).toEqual(["effect ran"]);
    }),
  );
});
