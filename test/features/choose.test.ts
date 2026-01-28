import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Guard, Machine, simulate, State } from "../../src/index.js";

describe("Choose Combinator", () => {
  test("first matching guard wins", async () => {
    const TestState = State({
      Idle: { value: Schema.Number },
      High: {},
      Medium: {},
      Low: {},
    });

    const TestEvent = Event({
      Check: {},
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle({ value: 75 }),
        })
          .choose(TestState.Idle, TestEvent.Check, [
            { guard: Guard.make("isHigh"), to: () => TestState.High },
            { guard: Guard.make("isMedium"), to: () => TestState.Medium },
            { otherwise: true, to: () => TestState.Low },
          ])
          .final(TestState.High)
          .final(TestState.Medium)
          .final(TestState.Low)
          .provide({
            isHigh: ({ state }: { state: { _tag: string; value?: number } }) =>
              state._tag === "Idle" && (state.value ?? 0) >= 70,
            isMedium: ({ state }: { state: { _tag: string; value?: number } }) =>
              state._tag === "Idle" && (state.value ?? 0) >= 40,
          });

        const result = yield* simulate(machine, [TestEvent.Check]);
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

    const TestEvent = Event({
      Check: {},
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle({ value: 10 }),
        })
          .choose(TestState.Idle, TestEvent.Check, [
            { guard: Guard.make("isHigh"), to: () => TestState.High },
            { otherwise: true, to: () => TestState.Low },
          ])
          .final(TestState.High)
          .final(TestState.Low)
          .provide({
            isHigh: ({ state }: { state: { _tag: string; value?: number } }) =>
              state._tag === "Idle" && (state.value ?? 0) >= 70,
          });

        const result = yield* simulate(machine, [TestEvent.Check]);
        expect(result.finalState._tag).toBe("Low");
      }),
    );
  });

  test("runs effect on matching branch", async () => {
    const TestState = State({
      Idle: {},
      Done: {},
    });

    const TestEvent = Event({
      Go: {},
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .choose(TestState.Idle, TestEvent.Go, [
            {
              otherwise: true,
              to: () => TestState.Done,
              effect: () =>
                Effect.sync(() => {
                  logs.push("effect ran");
                }),
            },
          ])
          .final(TestState.Done);

        yield* simulate(machine, [TestEvent.Go]);
        expect(logs).toEqual(["effect ran"]);
      }),
    );
  });
});
