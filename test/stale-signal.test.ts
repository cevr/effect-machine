// @effect-diagnostics strictEffectProvide:off - tests are entry points
// A task result, a fired state timeout or a spawn handler's send belongs to the
// state entry that started it. After that entry ends, the signal must not reach a
// later entry of the same state (reenter, or a round trip A -> B -> A).
import { Deferred, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Event, Machine, State } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const S = State({
  Active: { entry: Schema.Finite },
  Away: { entry: Schema.Finite },
  Done: { eventEntry: Schema.Finite, stateEntry: Schema.Finite },
  TimedOut: { stateEntry: Schema.Finite },
});
type S = typeof S.Type;

const E = Event({
  Kick: {},
  SlowKick: {},
  Leave: {},
  SlowLeave: {},
  Back: {},
  Result: { entry: Schema.Finite },
  Failed: { entry: Schema.Finite },
  Timeout: {},
});

const settle = Effect.gen(function* () {
  for (let i = 0; i < 5; i++) yield* yieldFibers;
});

/** One gate per entry: the task of entry n waits on gates[n]. */
const makeGates = (count: number) =>
  Effect.forEach(Array.from({ length: count }), () => Deferred.make<void>());

const baseMachine = () =>
  Machine.make({ state: S, event: E, initial: S.Active({ entry: 0 }) })
    .reenter(S.Active, E.Kick, ({ state }) => S.Active({ entry: state.entry + 1 }))
    .reenter(S.Active, E.SlowKick, ({ state }) =>
      Effect.sleep(Duration.seconds(2)).pipe(Effect.as(S.Active({ entry: state.entry + 1 }))),
    )
    .on(S.Active, E.Leave, ({ state }) => S.Away({ entry: state.entry }))
    .on(S.Active, E.SlowLeave, ({ state }) =>
      Effect.sleep(Duration.seconds(2)).pipe(Effect.as(S.Away({ entry: state.entry }))),
    )
    .on(S.Away, E.Back, ({ state }) => S.Active({ entry: state.entry + 1 }))
    .on(S.Active, E.Result, ({ state, event }) =>
      S.Done({ eventEntry: event.entry, stateEntry: state.entry }),
    )
    .on(S.Active, E.Failed, ({ state, event }) =>
      S.Done({ eventEntry: event.entry, stateEntry: state.entry }),
    )
    .on(S.Active, E.Timeout, ({ state }) => S.TimedOut({ stateEntry: state.entry }))
    .final(S.Done)
    .final(S.TimedOut);

describe("stale state-entry signals", () => {
  it.scopedLive("task result of an old entry is dropped after reenter", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates(3);
      const machine = baseMachine().task(
        S.Active,
        ({ state }) => Deferred.await(gates[state.entry]!).pipe(Effect.as(state.entry)),
        { onSuccess: (entry) => E.Result({ entry }) },
      );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      // Same tick: the Kick is queued first, then the old task completes and
      // queues its Result behind the Kick.
      yield* actor.send(E.Kick);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));

      // The current entry's own result still lands.
      yield* Deferred.succeed(gates[1]!, undefined);
      yield* settle;
      expect(yield* actor.snapshot).toEqual(S.Done({ eventEntry: 1, stateEntry: 1 }));
    }),
  );

  it.scopedLive("task result of an old entry is dropped after a round trip", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates(3);
      const machine = baseMachine().task(
        S.Active,
        ({ state }) => Deferred.await(gates[state.entry]!).pipe(Effect.as(state.entry)),
        { onSuccess: (entry) => E.Result({ entry }) },
      );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      yield* actor.send(E.Leave);
      yield* actor.send(E.Back);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
    }),
  );

  it.scopedLive("task failure event of an old entry is dropped after reenter", () =>
    Effect.gen(function* () {
      const gates = yield* makeGates(3);
      const machine = baseMachine().task(
        S.Active,
        ({ state }) =>
          Deferred.await(gates[state.entry]!).pipe(Effect.andThen(Effect.fail(state.entry))),
        {
          onSuccess: () => E.Kick,
          onFailure: (entry) => E.Failed({ entry }),
        },
      );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      yield* actor.send(E.Kick);
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
    }),
  );

  it.scopedLive("an interrupted task sends no failure event", () =>
    Effect.gen(function* () {
      // The run turns its own interruption into a typed failure.
      const machine = baseMachine().task(
        S.Active,
        ({ state }) =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Effect.void),
            Effect.catchCause(() => Effect.fail(state.entry)),
          ),
        {
          onSuccess: () => E.Kick,
          onFailure: (entry) => E.Failed({ entry }),
        },
      );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      yield* actor.send(E.Kick);
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
    }),
  );

  it.scoped("state timeout of an old entry is dropped after reenter", () =>
    Effect.gen(function* () {
      const machine = baseMachine().timeout(S.Active, {
        duration: Duration.seconds(5),
        event: E.Timeout,
      });
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      // The SlowKick handler runs from t=4s to t=6s. The old timer fires at
      // t=5s, while the handler runs, so its Timeout is queued behind the reentry.
      yield* TestClock.adjust("4 seconds");
      yield* settle;
      yield* actor.send(E.SlowKick);
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;

      // The new entry's timer started at t=6s, so it fires at t=11s.
      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
      yield* TestClock.adjust("5 seconds");
      yield* settle;
      expect(yield* actor.snapshot).toEqual(S.TimedOut({ stateEntry: 1 }));
    }),
  );

  it.scoped("state timeout of an old entry is dropped after a round trip", () =>
    Effect.gen(function* () {
      const machine = baseMachine().timeout(S.Active, {
        duration: Duration.seconds(5),
        event: E.Timeout,
      });
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      // The old timer fires while the SlowLeave handler runs; Back is queued
      // before it, so the stale Timeout is queued behind the round trip.
      yield* TestClock.adjust("4 seconds");
      yield* settle;
      yield* actor.send(E.SlowLeave);
      yield* actor.send(E.Back);
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;
      yield* TestClock.adjust("1 second");
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
    }),
  );

  // A child's output read by a task is owned by the task's entry. (A `.spawn`
  // handler that calls `self.send` itself is not owned: see the report of M46.)
  it.scopedLive("a child's output read by a task of an old entry is dropped after reenter", () =>
    Effect.gen(function* () {
      const ChildState = State({ Working: {}, Finished: {} });
      const ChildEvent = Event({ Finish: {} });
      const child = Machine.make({
        state: ChildState,
        event: ChildEvent,
        initial: ChildState.Working,
      })
        .on(ChildState.Working, ChildEvent.Finish, () => ChildState.Finished)
        .final(ChildState.Finished);

      const gates = yield* makeGates(3);
      const delivered = yield* makeGates(3);
      const machine = baseMachine().task(
        S.Active,
        ({ state, self }) =>
          Effect.gen(function* () {
            const ref = yield* self.spawn(`child-${state.entry}`, child).pipe(Effect.orDie);
            yield* Deferred.await(gates[state.entry]!);
            yield* ref.send(ChildEvent.Finish);
            yield* ref.awaitFinal.pipe(Effect.orDie);
            // The task maps the child's output; `delivered` pins when it sends.
            yield* Deferred.await(delivered[state.entry]!);
            return state.entry;
          }),
        { onSuccess: (entry) => E.Result({ entry }) },
      );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* settle;

      // The child finishes. Then, in one tick, the Kick is queued and the parent
      // handler sends the child's output behind it.
      yield* Deferred.succeed(gates[0]!, undefined);
      yield* settle;
      yield* actor.send(E.Kick);
      yield* Deferred.succeed(delivered[0]!, undefined);
      yield* settle;

      expect(yield* actor.snapshot).toEqual(S.Active({ entry: 1 }));
    }),
  );
});
