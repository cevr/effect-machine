// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

describe("on.force Transitions", () => {
  type PollState = State<{
    Polling: { attempts: number };
    Done: {};
  }>;
  const PollState = State<PollState>();

  type PollEvent = Event<{
    Poll: {};
    Reset: {};
    Finish: {};
  }>;
  const PollEvent = Event<PollEvent>();

  test("on.force runs exit/enter for same state tag", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const baseMachine = Machine.make<PollState, PollEvent>(
          PollState.Polling({ attempts: 0 }),
        ).pipe(
          Machine.on.force(PollState.Polling, PollEvent.Reset, ({ state }) =>
            PollState.Polling({ attempts: state.attempts + 1 }),
          ),
          Machine.on(PollState.Polling, PollEvent.Finish, () => PollState.Done()),
          Machine.onEnter(PollState.Polling, "enterPolling"),
          Machine.onExit(PollState.Polling, "exitPolling"),
        );

        const machine = Machine.provide(Machine.build(baseMachine), {
          enterPolling: ({ state }) =>
            Effect.sync(() =>
              effects.push(`enter:Polling:${(state as PollState & { _tag: "Polling" }).attempts}`),
            ),
          exitPolling: ({ state }) =>
            Effect.sync(() =>
              effects.push(`exit:Polling:${(state as PollState & { _tag: "Polling" }).attempts}`),
            ),
        });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("poller", machine);

        // Initial enter
        expect(effects).toEqual(["enter:Polling:0"]);

        // on.force runs exit/enter
        yield* actor.send(PollEvent.Reset());
        yield* yieldFibers;

        const state = yield* actor.state.get;
        expect(state._tag).toBe("Polling");
        expect((state as PollState & { _tag: "Polling" }).attempts).toBe(1);
        expect(effects).toEqual(["enter:Polling:0", "exit:Polling:0", "enter:Polling:1"]);

        // Another force transition
        yield* actor.send(PollEvent.Reset());
        yield* yieldFibers;

        expect(effects).toEqual([
          "enter:Polling:0",
          "exit:Polling:0",
          "enter:Polling:1",
          "exit:Polling:1",
          "enter:Polling:2",
        ]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("on.force restarts delay timer", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<PollState, PollEvent>(PollState.Polling({ attempts: 0 })).pipe(
            Machine.on.force(PollState.Polling, PollEvent.Reset, ({ state }) =>
              PollState.Polling({ attempts: state.attempts + 1 }),
            ),
            Machine.on(PollState.Polling, PollEvent.Poll, () => PollState.Done()),
            Machine.delay(PollState.Polling, "5 seconds", PollEvent.Poll()),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("poller", machine);

        // Advance 3 seconds
        yield* TestClock.adjust("3 seconds");
        yield* yieldFibers;

        let state = yield* actor.state.get;
        expect(state._tag).toBe("Polling");

        // Reset - should restart the 5 second timer
        yield* actor.send(PollEvent.Reset());
        yield* yieldFibers;

        // Advance another 3 seconds (6 total from start, but 3 from reset)
        yield* TestClock.adjust("3 seconds");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("Polling"); // Timer not done yet

        // Advance 2 more seconds (5 total from reset)
        yield* TestClock.adjust("2 seconds");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("Done"); // Timer fired
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });
});
