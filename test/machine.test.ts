import { Data, Effect } from "effect";
import { describe, expect, test } from "bun:test";

import { build, final, make, on, simulate } from "../src/index.js";

type CounterState = Data.TaggedEnum<{
  Idle: { count: number };
  Counting: { count: number };
  Done: { count: number };
}>;
const State = Data.taggedEnum<CounterState>();

type CounterEvent = Data.TaggedEnum<{
  Start: {};
  Increment: {};
  Stop: {};
}>;
const Event = Data.taggedEnum<CounterEvent>();

describe("Machine", () => {
  test("creates machine with initial state using .pipe() syntax", () => {
    const machine = build(
      make<CounterState, CounterEvent>(State.Idle({ count: 0 })).pipe(
        on(State.Idle, Event.Start, ({ state }) => State.Counting({ count: state.count })),
      ),
    );
    expect(machine.initial._tag).toBe("Idle");
    expect(machine.initial.count).toBe(0);
  });

  test("defines transitions between states", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          make<CounterState, CounterEvent>(State.Idle({ count: 0 })).pipe(
            on(State.Idle, Event.Start, ({ state }) => State.Counting({ count: state.count })),
            on(State.Counting, Event.Increment, ({ state }) =>
              State.Counting({ count: state.count + 1 }),
            ),
            on(State.Counting, Event.Stop, ({ state }) => State.Done({ count: state.count })),
            final(State.Done),
          ),
        );

        const result = yield* simulate(machine, [
          Event.Start(),
          Event.Increment(),
          Event.Increment(),
          Event.Stop(),
        ]);

        expect(result.finalState._tag).toBe("Done");
        expect(result.finalState.count).toBe(2);
      }),
    );
  });

  test("supports guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          make<CounterState, CounterEvent>(State.Counting({ count: 0 })).pipe(
            on(
              State.Counting,
              Event.Increment,
              ({ state }) => State.Counting({ count: state.count + 1 }),
              {
                guard: ({ state }) => state.count < 3,
              },
            ),
            on(State.Counting, Event.Stop, ({ state }) => State.Done({ count: state.count })),
            final(State.Done),
          ),
        );

        const result = yield* simulate(machine, [
          Event.Increment(),
          Event.Increment(),
          Event.Increment(),
          Event.Increment(), // blocked
          Event.Stop(),
        ]);

        expect(result.finalState.count).toBe(3);
      }),
    );
  });

  test("supports transition effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = build(
          make<CounterState, CounterEvent>(State.Idle({ count: 0 })).pipe(
            on(State.Idle, Event.Start, ({ state }) => State.Counting({ count: state.count }), {
              effect: ({ state }) =>
                Effect.sync(() => {
                  logs.push(`Starting from count ${state.count}`);
                }),
            }),
            on(State.Counting, Event.Stop, ({ state }) => State.Done({ count: state.count })),
            final(State.Done),
          ),
        );

        yield* simulate(machine, [Event.Start(), Event.Stop()]);
        expect(logs).toEqual(["Starting from count 0"]);
      }),
    );
  });

  test("marks states as final", () => {
    const machine = build(
      make<CounterState, CounterEvent>(State.Idle({ count: 0 })).pipe(
        on(State.Idle, Event.Start, () => State.Done({ count: 0 })),
        final(State.Done),
      ),
    );
    expect(machine.finalStates.has("Done")).toBe(true);
    expect(machine.finalStates.has("Idle")).toBe(false);
  });
});
