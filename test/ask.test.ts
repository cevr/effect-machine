// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import { Machine, State, Event } from "../src/index.js";
import { describe, expect, it } from "effect-bun-test";

const TestState = State({
  Idle: {},
  Active: { count: Schema.Number },
  Done: {},
});

const TestEvent = Event({
  Start: {},
  Increment: {},
  GetCount: {},
  GetNothing: {},
  Stop: {},
});

const createMachine = () =>
  Machine.make({
    state: TestState,
    event: TestEvent,
    initial: TestState.Idle,
  })
    .on(TestState.Idle, TestEvent.Start, () => TestState.Active({ count: 0 }))
    .on(TestState.Active, TestEvent.Increment, ({ state }) =>
      TestState.Active({ count: state.count + 1 }),
    )
    // Handler that returns { state, reply } — domain reply for ask
    .on(TestState.Active, TestEvent.GetCount, ({ state }) => ({
      state: TestState.Active({ count: state.count }),
      reply: state.count,
    }))
    // Handler that returns { state, reply: undefined } — explicit undefined reply
    .on(TestState.Active, TestEvent.GetNothing, ({ state }) => ({
      state: TestState.Active({ count: state.count }),
      reply: undefined,
    }))
    .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
    .final(TestState.Done)
    .build();

describe("ActorRef.ask", () => {
  it.scopedLive("returns domain reply value from handler", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.call(TestEvent.Start);
      yield* actor.call(TestEvent.Increment);
      yield* actor.call(TestEvent.Increment);

      const count = yield* actor.ask<number>(TestEvent.GetCount);
      expect(count).toBe(2);
    }),
  );

  it.scopedLive("fails with NoReplyError when handler does not reply", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.call(TestEvent.Start);

      // Increment handler returns just a state (no reply field)
      const result = yield* actor.ask(TestEvent.Increment).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.scopedLive("fails with ActorStoppedError on stopped actor", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.stop;

      const result = yield* actor.ask(TestEvent.Start).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.scopedLive("call still returns ProcessEventResult (unchanged)", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.call(TestEvent.Start);
      yield* actor.call(TestEvent.Increment);
      yield* actor.call(TestEvent.Increment);

      // call on GetCount handler returns ProcessEventResult, not the reply value
      const result = yield* actor.call(TestEvent.GetCount);
      expect(result.transitioned).toBe(true);
      expect(result.newState._tag).toBe("Active");
      // The reply field is on the result for inspection but call returns the full result
      expect(result.reply).toBe(2);
    }),
  );

  it.scopedLive("ask works with multiple sequential calls", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.call(TestEvent.Start);

      yield* actor.call(TestEvent.Increment);
      const count1 = yield* actor.ask<number>(TestEvent.GetCount);
      expect(count1).toBe(1);

      yield* actor.call(TestEvent.Increment);
      const count2 = yield* actor.ask<number>(TestEvent.GetCount);
      expect(count2).toBe(2);
    }),
  );

  it.scopedLive("reply: undefined is a valid reply, not NoReplyError", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.call(TestEvent.Start);

      const result = yield* actor.ask<undefined>(TestEvent.GetNothing);
      expect(result).toBeUndefined();
    }),
  );
});
