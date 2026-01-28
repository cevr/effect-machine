// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, TestClock } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  Slot,
  State,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "./utils/effect-test.js";

describe("reenter Transitions", () => {
  const PollState = State({
    Polling: { attempts: Schema.Number },
    Done: {},
  });
  type PollState = typeof PollState.Type;

  const PollEvent = Event({
    Poll: {},
    Reset: {},
    Finish: {},
  });

  const PollEffects = Slot.Effects({
    runPollingEffect: {},
  });

  it.scopedLive("reenter runs exit/enter for same state tag", () =>
    Effect.gen(function* () {
      const effects: string[] = [];

      const machine = Machine.make({
        state: PollState,
        event: PollEvent,
        initial: PollState.Polling({ attempts: 0 }),
      })
        .on(PollState.Polling, PollEvent.Finish, () => PollState.Done)
        .reenter(PollState.Polling, PollEvent.Reset, ({ state }) =>
          PollState.Polling({ attempts: state.attempts + 1 }),
        )
        .spawn(PollState.Polling, ({ state }) =>
          Effect.gen(function* () {
            // Log entry
            effects.push(`enter:Polling:${(state as PollState & { _tag: "Polling" }).attempts}`);
            // Log exit via finalizer
            yield* Effect.addFinalizer(() =>
              Effect.sync(() =>
                effects.push(`exit:Polling:${(state as PollState & { _tag: "Polling" }).attempts}`),
              ),
            );
          }),
        );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("poller", machine);
      yield* yieldFibers; // Let spawn effect run

      // Initial enter
      expect(effects).toEqual(["enter:Polling:0"]);

      // reenter runs exit/enter
      yield* actor.send(PollEvent.Reset);
      yield* yieldFibers;

      const state = yield* actor.state.get;
      expect(state._tag).toBe("Polling");
      expect((state as PollState & { _tag: "Polling" }).attempts).toBe(1);
      expect(effects).toEqual(["enter:Polling:0", "exit:Polling:0", "enter:Polling:1"]);

      // Another reenter transition
      yield* actor.send(PollEvent.Reset);
      yield* yieldFibers;

      expect(effects).toEqual([
        "enter:Polling:0",
        "exit:Polling:0",
        "enter:Polling:1",
        "exit:Polling:1",
        "enter:Polling:2",
      ]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("reenter restarts spawn timeout timer", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: PollState,
        event: PollEvent,
        effects: PollEffects,
        initial: PollState.Polling({ attempts: 0 }),
      })
        .on(PollState.Polling, PollEvent.Poll, () => PollState.Done)
        .reenter(PollState.Polling, PollEvent.Reset, ({ state }) =>
          PollState.Polling({ attempts: state.attempts + 1 }),
        )
        .spawn(PollState.Polling, ({ effects }) => effects.runPollingEffect())
        .provide({
          runPollingEffect: (_, { self }) =>
            Effect.sleep("5 seconds").pipe(Effect.andThen(self.send(PollEvent.Poll))),
        });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("poller", machine);

      // Advance 3 seconds
      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      let state = yield* actor.state.get;
      expect(state._tag).toBe("Polling");

      // Reset - should restart the 5 second timer
      yield* actor.send(PollEvent.Reset);
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
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
