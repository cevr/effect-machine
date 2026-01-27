import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

describe("Always Transitions", () => {
  test("applies eventless transition on state entry", async () => {
    type TestState = State<{
      Calculating: { value: number };
      High: { value: number };
      Low: { value: number };
    }>;
    const TestState = State<TestState>();

    type TestEvent = Event<{
      SetValue: { value: number };
    }>;
    const TestEvent = Event<TestEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Calculating({ value: 75 })).pipe(
            Machine.always(TestState.Calculating, [
              { guard: (s) => s.value >= 70, to: (s) => TestState.High({ value: s.value }) },
              { otherwise: true, to: (s) => TestState.Low({ value: s.value }) },
            ]),
            Machine.final(TestState.High),
            Machine.final(TestState.Low),
          ),
        );

        // Initial state should already be High due to always transition
        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("High");
      }),
    );
  });

  test("cascades through multiple always transitions", async () => {
    type TestState = State<{
      A: { n: number };
      B: { n: number };
      C: { n: number };
      Done: { n: number };
    }>;
    const TestState = State<TestState>();

    type TestEvent = Event<{ Start: {} }>;
    const TestEvent = Event<TestEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.A({ n: 0 })).pipe(
            Machine.always(TestState.A, [
              { otherwise: true, to: (s) => TestState.B({ n: s.n + 1 }) },
            ]),
            Machine.always(TestState.B, [
              { otherwise: true, to: (s) => TestState.C({ n: s.n + 1 }) },
            ]),
            Machine.always(TestState.C, [
              { otherwise: true, to: (s) => TestState.Done({ n: s.n + 1 }) },
            ]),
            Machine.final(TestState.Done),
          ),
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
    type TestState = State<{
      Input: { value: number };
      High: {};
      Medium: {};
      Low: {};
    }>;
    const TestState = State<TestState>();

    type TestEvent = Event<{ Process: {} }>;
    const TestEvent = Event<TestEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Input({ value: 50 })).pipe(
            Machine.always(TestState.Input, [
              { guard: (s) => s.value >= 70, to: () => TestState.High() },
              { guard: (s) => s.value >= 40, to: () => TestState.Medium() },
              { otherwise: true, to: () => TestState.Low() },
            ]),
            Machine.final(TestState.High),
            Machine.final(TestState.Medium),
            Machine.final(TestState.Low),
          ),
        );

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Medium");
      }),
    );
  });
});
