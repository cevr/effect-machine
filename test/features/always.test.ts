// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State, Slot } from "../../src/index.js";

describe("Always Transitions", () => {
  test("applies eventless transition on state entry", async () => {
    const TestState = State({
      Calculating: { value: Schema.Number },
      High: { value: Schema.Number },
      Low: { value: Schema.Number },
    });

    const TestEvent = Event({
      SetValue: { value: Schema.Number },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Calculating({ value: 75 }),
        })
          .always(TestState.Calculating, (state) => {
            if (state.value >= 70) {
              return TestState.High({ value: state.value });
            }
            return TestState.Low({ value: state.value });
          })
          .final(TestState.High)
          .final(TestState.Low);

        // Initial state should already be High due to always transition
        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("High");
      }),
    );
  });

  test("cascades through multiple always transitions", async () => {
    const TestState = State({
      A: { n: Schema.Number },
      B: { n: Schema.Number },
      C: { n: Schema.Number },
      Done: { n: Schema.Number },
    });

    const TestEvent = Event({ Start: {} });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.A({ n: 0 }),
        })
          .always(TestState.A, (s) => TestState.B({ n: s.n + 1 }))
          .always(TestState.B, (s) => TestState.C({ n: s.n + 1 }))
          .always(TestState.C, (s) => TestState.Done({ n: s.n + 1 }))
          .final(TestState.Done);

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Done");
        if (result.finalState._tag === "Done") {
          expect(result.finalState.n).toBe(3);
        }
      }),
    );
  });

  test("guard logic in always handler - first match wins", async () => {
    const TestState = State({
      Input: { value: Schema.Number },
      High: {},
      Medium: {},
      Low: {},
    });

    const TestEvent = Event({ Process: {} });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Input({ value: 50 }),
        })
          .always(TestState.Input, (s) => {
            if (s.value >= 70) return TestState.High;
            if (s.value >= 40) return TestState.Medium;
            return TestState.Low;
          })
          .final(TestState.High)
          .final(TestState.Medium)
          .final(TestState.Low);

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Medium");
      }),
    );
  });

  test("always with async guard via Effect", async () => {
    const TestState = State({
      Check: { value: Schema.Number },
      Pass: {},
      Fail: {},
    });

    const TestEvent = Event({ Start: {} });

    const TestGuards = Slot.Guards({
      isValid: { threshold: Schema.Number },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          guards: TestGuards,
          initial: TestState.Check({ value: 75 }),
        })
          .always(TestState.Check, (state, guards) =>
            Effect.gen(function* () {
              if (yield* guards.isValid({ threshold: 50 })) {
                return TestState.Pass;
              }
              return TestState.Fail;
            }),
          )
          .final(TestState.Pass)
          .final(TestState.Fail)
          .provide({
            isValid: ({ threshold }, { state }) =>
              state._tag === "Check" && state.value >= threshold,
          });

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Pass");
      }),
    );
  });
});
