import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import { always, build, final, make, simulate } from "../../src/index.js";

describe("Always Transitions", () => {
  test("applies eventless transition on state entry", async () => {
    type State = Data.TaggedEnum<{
      Calculating: { value: number };
      High: { value: number };
      Low: { value: number };
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{
      SetValue: { value: number };
    }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Calculating({ value: 75 })),
            always(State.Calculating, [
              { guard: (s) => s.value >= 70, to: (s) => State.High({ value: s.value }) },
              { otherwise: true, to: (s) => State.Low({ value: s.value }) },
            ]),
            final(State.High),
            final(State.Low),
          ),
        );

        // Initial state should already be High due to always transition
        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("High");
      }),
    );
  });

  test("cascades through multiple always transitions", async () => {
    type State = Data.TaggedEnum<{
      A: { n: number };
      B: { n: number };
      C: { n: number };
      Done: { n: number };
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{ Start: {} }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.A({ n: 0 })),
            always(State.A, [{ otherwise: true, to: (s) => State.B({ n: s.n + 1 }) }]),
            always(State.B, [{ otherwise: true, to: (s) => State.C({ n: s.n + 1 }) }]),
            always(State.C, [{ otherwise: true, to: (s) => State.Done({ n: s.n + 1 }) }]),
            final(State.Done),
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
    type State = Data.TaggedEnum<{
      Input: { value: number };
      High: {};
      Medium: {};
      Low: {};
    }>;
    const State = Data.taggedEnum<State>();

    type Event = Data.TaggedEnum<{ Process: {} }>;
    const Event = Data.taggedEnum<Event>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Input({ value: 50 })),
            always(State.Input, [
              { guard: (s) => s.value >= 70, to: () => State.High() },
              { guard: (s) => s.value >= 40, to: () => State.Medium() },
              { otherwise: true, to: () => State.Low() },
            ]),
            final(State.High),
            final(State.Medium),
            final(State.Low),
          ),
        );

        const result = yield* simulate(machine, []);
        expect(result.finalState._tag).toBe("Medium");
      }),
    );
  });
});
