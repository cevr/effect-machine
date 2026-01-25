import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  build,
  final,
  make,
  on,
  yieldFibers,
} from "../src/index.js";

type TestState = Data.TaggedEnum<{
  Idle: {};
  Active: { value: number };
  Done: {};
}>;
const State = Data.taggedEnum<TestState>();

type TestEvent = Data.TaggedEnum<{
  Start: { value: number };
  Update: { value: number };
  Stop: {};
}>;
const Event = Data.taggedEnum<TestEvent>();

describe("ActorSystem", () => {
  test("spawns actors and processes events", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<TestState, TestEvent>(State.Idle()),
            on(State.Idle, Event.Start, ({ event }) => State.Active({ value: event.value })),
            on(State.Active, Event.Update, ({ event }) => State.Active({ value: event.value })),
            on(State.Active, Event.Stop, () => State.Done()),
            final(State.Done),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test-actor", machine);

        yield* actor.send(Event.Start({ value: 10 }));
        yield* yieldFibers;

        const state1 = yield* actor.state.get;
        expect(state1._tag).toBe("Active");

        yield* actor.send(Event.Update({ value: 20 }));
        yield* yieldFibers;

        const state2 = yield* actor.state.get;
        expect(state2._tag).toBe("Active");
        if (state2._tag === "Active") {
          expect(state2.value).toBe(20);
        }

        yield* actor.send(Event.Stop());
        yield* yieldFibers;

        const state3 = yield* actor.state.get;
        expect(state3._tag).toBe("Done");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("stops actors properly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<TestState, TestEvent>(State.Idle()),
            on(State.Idle, Event.Start, ({ event }) => State.Active({ value: event.value })),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test-actor", machine);

        yield* actor.send(Event.Start({ value: 5 }));
        yield* yieldFibers;

        yield* system.stop("test-actor");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
