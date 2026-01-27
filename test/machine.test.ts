import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Machine, simulate, State, Event } from "../src/index.js";

const CounterState = State({
  Idle: { count: Schema.Number },
  Counting: { count: Schema.Number },
  Done: { count: Schema.Number },
});
type CounterState = typeof CounterState.Type;

const CounterEvent = Event({
  Start: {},
  Increment: {},
  Stop: {},
});
type CounterEvent = typeof CounterEvent.Type;

describe("Machine", () => {
  test("creates machine with initial state using .pipe() syntax", () => {
    const machine = Machine.make<CounterState, CounterEvent>(CounterState.Idle({ count: 0 })).pipe(
      Machine.on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
        CounterState.Counting({ count: state.count }),
      ),
    );
    expect(machine.initial._tag).toBe("Idle");
    expect(machine.initial.count).toBe(0);
  });

  test("defines transitions between states", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<CounterState, CounterEvent>(
          CounterState.Idle({ count: 0 }),
        ).pipe(
          Machine.on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
            CounterState.Counting({ count: state.count }),
          ),
          Machine.on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
            CounterState.Counting({ count: state.count + 1 }),
          ),
          Machine.on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          ),
          Machine.final(CounterState.Done),
        );

        const result = yield* simulate(machine, [
          CounterEvent.Start(),
          CounterEvent.Increment(),
          CounterEvent.Increment(),
          CounterEvent.Stop(),
        ]);

        expect(result.finalState._tag).toBe("Done");
        expect(result.finalState.count).toBe(2);
      }),
    );
  });

  test("supports guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<CounterState, CounterEvent>(
          CounterState.Counting({ count: 0 }),
        ).pipe(
          Machine.on(
            CounterState.Counting,
            CounterEvent.Increment,
            ({ state }) => CounterState.Counting({ count: state.count + 1 }),
            {
              guard: ({ state }) => state.count < 3,
            },
          ),
          Machine.on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          ),
          Machine.final(CounterState.Done),
        );

        const result = yield* simulate(machine, [
          CounterEvent.Increment(),
          CounterEvent.Increment(),
          CounterEvent.Increment(),
          CounterEvent.Increment(), // blocked
          CounterEvent.Stop(),
        ]);

        expect(result.finalState.count).toBe(3);
      }),
    );
  });

  test("supports transition effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make<CounterState, CounterEvent>(
          CounterState.Idle({ count: 0 }),
        ).pipe(
          Machine.on(
            CounterState.Idle,
            CounterEvent.Start,
            ({ state }) => CounterState.Counting({ count: state.count }),
            {
              effect: ({ state }) =>
                Effect.sync(() => {
                  logs.push(`Starting from count ${state.count}`);
                }),
            },
          ),
          Machine.on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          ),
          Machine.final(CounterState.Done),
        );

        yield* simulate(machine, [CounterEvent.Start(), CounterEvent.Stop()]);
        expect(logs).toEqual(["Starting from count 0"]);
      }),
    );
  });

  test("marks states as final", () => {
    const machine = Machine.make<CounterState, CounterEvent>(CounterState.Idle({ count: 0 })).pipe(
      Machine.on(CounterState.Idle, CounterEvent.Start, () => CounterState.Done({ count: 0 })),
      Machine.final(CounterState.Done),
    );
    expect(machine.finalStates.has("Done")).toBe(true);
    expect(machine.finalStates.has("Idle")).toBe(false);
  });
});
