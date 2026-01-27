import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

describe("Always Transitions", () => {
  test("applies eventless transition on state entry", async () => {
    const TestState = State({
      Calculating: { value: Schema.Number },
      High: { value: Schema.Number },
      Low: { value: Schema.Number },
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      SetValue: { value: Schema.Number },
    });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Calculating({ value: 75 }),
        }).pipe(
          Machine.always(TestState.Calculating, [
            { guard: (s) => s.value >= 70, to: (s) => TestState.High({ value: s.value }) },
            { to: (s) => TestState.Low({ value: s.value }) },
          ]),
          Machine.final(TestState.High),
          Machine.final(TestState.Low),
        );

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
    type TestState = typeof TestState.Type;

    const TestEvent = Event({ Start: {} });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.A({ n: 0 }),
        }).pipe(
          Machine.always(TestState.A, [{ to: (s) => TestState.B({ n: s.n + 1 }) }]),
          Machine.always(TestState.B, [{ to: (s) => TestState.C({ n: s.n + 1 }) }]),
          Machine.always(TestState.C, [{ to: (s) => TestState.Done({ n: s.n + 1 }) }]),
          Machine.final(TestState.Done),
        );

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Done");
        if (result.finalState._tag === "Done") {
          expect(result.finalState.n).toBe(3);
        }
      }),
    );
  });

  test("guard cascade - first match wins", async () => {
    const TestState = State({
      Input: { value: Schema.Number },
      High: {},
      Medium: {},
      Low: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({ Process: {} });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Input({ value: 50 }),
        }).pipe(
          Machine.always(TestState.Input, [
            { guard: (s) => s.value >= 70, to: () => TestState.High },
            { guard: (s) => s.value >= 40, to: () => TestState.Medium },
            { to: () => TestState.Low },
          ]),
          Machine.final(TestState.High),
          Machine.final(TestState.Medium),
          Machine.final(TestState.Low),
        );

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Medium");
      }),
    );
  });
});
