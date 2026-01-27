import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

describe("Choose Combinator", () => {
  test("first matching guard wins", async () => {
    const TestState = State({
      Idle: { value: Schema.Number },
      High: {},
      Medium: {},
      Low: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Check: {},
    });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle({ value: 75 }),
        }).pipe(
          Machine.choose(TestState.Idle, TestEvent.Check, [
            { guard: ({ state }) => state.value >= 70, to: () => TestState.High({}) },
            { guard: ({ state }) => state.value >= 40, to: () => TestState.Medium({}) },
            { otherwise: true, to: () => TestState.Low({}) },
          ]),
          Machine.final(TestState.High),
          Machine.final(TestState.Medium),
          Machine.final(TestState.Low),
        );

        const result = yield* simulate(machine, [TestEvent.Check({})]);
        expect(result.finalState._tag).toBe("High");
      }),
    );
  });

  test("otherwise branch catches all", async () => {
    const TestState = State({
      Idle: { value: Schema.Number },
      High: {},
      Low: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Check: {},
    });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle({ value: 10 }),
        }).pipe(
          Machine.choose(TestState.Idle, TestEvent.Check, [
            { guard: ({ state }) => state.value >= 70, to: () => TestState.High({}) },
            { otherwise: true, to: () => TestState.Low({}) },
          ]),
          Machine.final(TestState.High),
          Machine.final(TestState.Low),
        );

        const result = yield* simulate(machine, [TestEvent.Check({})]);
        expect(result.finalState._tag).toBe("Low");
      }),
    );
  });

  test("runs effect on matching branch", async () => {
    const TestState = State({
      Idle: {},
      Done: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Go: {},
    });
    type TestEvent = typeof TestEvent.Type;

    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle({}),
        }).pipe(
          Machine.choose(TestState.Idle, TestEvent.Go, [
            {
              otherwise: true,
              to: () => TestState.Done({}),
              effect: () =>
                Effect.sync(() => {
                  logs.push("effect ran");
                }),
            },
          ]),
          Machine.final(TestState.Done),
        );

        yield* simulate(machine, [TestEvent.Go({})]);
        expect(logs).toEqual(["effect ran"]);
      }),
    );
  });
});
