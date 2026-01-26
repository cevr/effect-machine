// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Machine,
  yieldFibers,
  State,
  Event,
} from "../src/index.js";

type TestState = State.TaggedEnum<{
  Idle: {};
  Active: { value: number };
  Done: {};
}>;
const TestState = State.taggedEnum<TestState>();

type TestEvent = Event.TaggedEnum<{
  Start: { value: number };
  Update: { value: number };
  Stop: {};
}>;
const TestEvent = Event.taggedEnum<TestEvent>();

describe("ActorSystem", () => {
  test("spawns actors and processes events", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
              TestState.Active({ value: event.value }),
            ),
            Machine.on(TestState.Active, TestEvent.Update, ({ event }) =>
              TestState.Active({ value: event.value }),
            ),
            Machine.on(TestState.Active, TestEvent.Stop, () => TestState.Done()),
            Machine.final(TestState.Done),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test-actor", machine);

        yield* actor.send(TestEvent.Start({ value: 10 }));
        yield* yieldFibers;

        const state1 = yield* actor.state.get;
        expect(state1._tag).toBe("Active");

        yield* actor.send(TestEvent.Update({ value: 20 }));
        yield* yieldFibers;

        const state2 = yield* actor.state.get;
        expect(state2._tag).toBe("Active");
        if (state2._tag === "Active") {
          expect(state2.value).toBe(20);
        }

        yield* actor.send(TestEvent.Stop());
        yield* yieldFibers;

        const state3 = yield* actor.state.get;
        expect(state3._tag).toBe("Done");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("stops actors properly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
              TestState.Active({ value: event.value }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test-actor", machine);

        yield* actor.send(TestEvent.Start({ value: 5 }));
        yield* yieldFibers;

        yield* system.stop("test-actor");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
