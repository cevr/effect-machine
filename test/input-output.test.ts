import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";
import { Event, Machine, simulate, State, type ActorLifecycle } from "../src/index.js";

const CounterState = State({
  Ready: { count: Schema.Finite },
  Done: { count: Schema.Finite },
});

const CounterEvent = Event({
  Add: { amount: Schema.Finite },
  Finish: {},
});

const counter = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: (input: { readonly count: number }) => CounterState.Ready(input),
})
  .on(CounterState.Ready, CounterEvent.Add, ({ state, event }) =>
    CounterState.Ready({ count: state.count + event.amount }),
  )
  .on(CounterState.Ready, CounterEvent.Finish, ({ state }) =>
    CounterState.Done({ count: state.count }),
  )
  .final(CounterState.Done, ({ state }) => ({ total: state.count }));

describe("machine input and output", () => {
  it.scopedLive("creates independent actor state from required input", () =>
    Effect.gen(function* () {
      const first = yield* Machine.spawn(counter, { input: { count: 2 } });
      const second = yield* Machine.spawn(counter, { input: { count: 10 } });
      yield* first.start;
      yield* second.start;

      expect((yield* first.snapshot).count).toBe(2);
      expect((yield* second.snapshot).count).toBe(10);

      yield* first.stop;
      yield* second.stop;
    }),
  );

  it.scopedLive("returns a typed output while it retains the final state", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(counter, { input: { count: 3 } });
      yield* actor.start;
      yield* actor.send(CounterEvent.Add({ amount: 4 }));
      yield* actor.send(CounterEvent.Finish);

      const output: { readonly total: number } = yield* actor.awaitOutput;
      const exit = yield* actor.awaitExit;
      yield* Effect.yieldNow;
      const lifecycle: ActorLifecycle<typeof CounterState.Type, { readonly total: number }> =
        actor.client.getLifecycle();

      expect(output).toEqual({ total: 7 });
      expect(exit).toEqual({
        _tag: "Final",
        state: CounterState.Done({ count: 7 }),
        output: { total: 7 },
      });
      expect(lifecycle).toEqual(exit);
      expect((yield* actor.snapshot)._tag).toBe("Done");
    }),
  );

  it.scopedLive("uses explicit input in simulation and replay", () =>
    Effect.gen(function* () {
      const events = [CounterEvent.Add({ amount: 2 }), CounterEvent.Finish];
      const simulated = yield* simulate(counter, events, { input: { count: 4 } });
      const replayed = yield* Machine.replay(counter, events, { input: { count: 4 } });

      expect(simulated.finalState).toEqual(CounterState.Done({ count: 6 }));
      expect(replayed).toEqual(CounterState.Done({ count: 6 }));
    }),
  );

  it.scopedLive("runs an autonomous machine to typed output", () =>
    Effect.gen(function* () {
      const InstantState = State({ Done: { value: Schema.String } });
      const InstantEvent = Event({ Refresh: {} });
      const instant = Machine.make({
        state: InstantState,
        event: InstantEvent,
        initial: (input: { readonly value: string }) => InstantState.Done(input),
      }).final(InstantState.Done, ({ state }) => state.value);

      const output: string = yield* Machine.run(instant, { input: { value: "ready" } });

      expect(output).toBe("ready");
    }),
  );

  it.scopedLive("releases a running actor when the run is interrupted", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const RunningState = State({ Active: {} });
      const RunningEvent = Event({ Refresh: {} });
      const running = Machine.make({
        state: RunningState,
        event: RunningEvent,
        initial: RunningState.Active,
      }).background(() =>
        Effect.acquireUseRelease(
          Deferred.succeed(ready, undefined),
          () => Effect.never,
          () => Ref.set(released, true),
        ),
      );

      const fiber = yield* Effect.forkChild(Machine.run(running));
      yield* Deferred.await(ready);
      yield* Fiber.interrupt(fiber);

      expect(yield* Ref.get(released)).toBe(true);
    }),
  );
});
