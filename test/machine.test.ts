// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Machine, simulate, State, Event, Slot } from "../src/index.js";

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

describe("Machine", () => {
  test("creates machine with initial state using .pipe() syntax", () => {
    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      initial: CounterState.Idle({ count: 0 }),
    }).on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
      CounterState.Counting({ count: state.count }),
    );
    expect(machine.initial._tag).toBe("Idle");
    expect(machine.initial.count).toBe(0);
  });

  test("defines transitions between states", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: CounterState,
          event: CounterEvent,
          initial: CounterState.Idle({ count: 0 }),
        })
          .on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
            CounterState.Counting({ count: state.count }),
          )
          .on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
            CounterState.Counting({ count: state.count + 1 }),
          )
          .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          )
          .final(CounterState.Done);

        const result = yield* simulate(machine, [
          CounterEvent.Start,
          CounterEvent.Increment,
          CounterEvent.Increment,
          CounterEvent.Stop,
        ]);

        expect(result.finalState._tag).toBe("Done");
        expect(result.finalState.count).toBe(2);
      }),
    );
  });

  test("supports guards via Slot.Guards", async () => {
    const CounterGuards = Slot.Guards({
      belowLimit: { limit: Schema.Number },
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: CounterState,
          event: CounterEvent,
          guards: CounterGuards,
          initial: CounterState.Counting({ count: 0 }),
        })
          .on(CounterState.Counting, CounterEvent.Increment, ({ state, guards }) =>
            Effect.gen(function* () {
              if (yield* guards.belowLimit({ limit: 3 })) {
                return CounterState.Counting({ count: state.count + 1 });
              }
              return state;
            }),
          )
          .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          )
          .final(CounterState.Done)
          .provide({
            // Handler receives (params, ctx) - context passed directly
            belowLimit: ({ limit }, { state }) => state.count < limit,
          });

        const result = yield* simulate(machine, [
          CounterEvent.Increment,
          CounterEvent.Increment,
          CounterEvent.Increment,
          CounterEvent.Increment, // blocked
          CounterEvent.Stop,
        ]);

        expect(result.finalState.count).toBe(3);
      }),
    );
  });

  test("supports effects in handler via Effect<State>", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make({
          state: CounterState,
          event: CounterEvent,
          initial: CounterState.Idle({ count: 0 }),
        })
          .on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
            Effect.gen(function* () {
              yield* Effect.sync(() => logs.push(`Starting from count ${state.count}`));
              return CounterState.Counting({ count: state.count });
            }),
          )
          .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
            CounterState.Done({ count: state.count }),
          )
          .final(CounterState.Done);

        yield* simulate(machine, [CounterEvent.Start, CounterEvent.Stop]);
        expect(logs).toEqual(["Starting from count 0"]);
      }),
    );
  });

  test("marks states as final", () => {
    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      initial: CounterState.Idle({ count: 0 }),
    })
      .on(CounterState.Idle, CounterEvent.Start, () => CounterState.Done({ count: 0 }))
      .final(CounterState.Done);
    expect(machine.finalStates.has("Done")).toBe(true);
    expect(machine.finalStates.has("Idle")).toBe(false);
  });
});
