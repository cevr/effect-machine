import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import { build, choose, final, make, simulate } from "../../src/index.js";

describe("Choose Combinator", () => {
  test("first matching guard wins", async () => {
    type State = Data.TaggedEnum<{
      Idle: { value: number };
      High: {};
      Medium: {};
      Low: {};
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{
      Check: {};
    }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ value: 75 })),
            choose(State.Idle, Event.Check, [
              { guard: ({ state }) => state.value >= 70, to: () => State.High() },
              { guard: ({ state }) => state.value >= 40, to: () => State.Medium() },
              { otherwise: true, to: () => State.Low() },
            ]),
            final(State.High),
            final(State.Medium),
            final(State.Low),
          ),
        );

        const result = yield* simulate(machine, [Event.Check()]);
        expect(result.finalState._tag).toBe("High");
      }),
    );
  });

  test("otherwise branch catches all", async () => {
    type State = Data.TaggedEnum<{
      Idle: { value: number };
      High: {};
      Low: {};
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{
      Check: {};
    }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ value: 10 })),
            choose(State.Idle, Event.Check, [
              { guard: ({ state }) => state.value >= 70, to: () => State.High() },
              { otherwise: true, to: () => State.Low() },
            ]),
            final(State.High),
            final(State.Low),
          ),
        );

        const result = yield* simulate(machine, [Event.Check()]);
        expect(result.finalState._tag).toBe("Low");
      }),
    );
  });

  test("runs effect on matching branch", async () => {
    type State = Data.TaggedEnum<{
      Idle: {};
      Done: {};
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{
      Go: {};
    }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = build(
          pipe(
            make<State, Event>(State.Idle()),
            choose(State.Idle, Event.Go, [
              {
                otherwise: true,
                to: () => State.Done(),
                effect: () =>
                  Effect.sync(() => {
                    logs.push("effect ran");
                  }),
              },
            ]),
            final(State.Done),
          ),
        );

        yield* simulate(machine, [Event.Go()]);
        expect(logs).toEqual(["effect ran"]);
      }),
    );
  });
});
