import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import {
  build,
  createTestHarness,
  final,
  make,
  on,
  simulate,
  assertReaches,
} from "../src/index.js";

type TestState = Data.TaggedEnum<{
  Idle: {};
  Loading: {};
  Success: { data: string };
  Error: { message: string };
}>;
const State = Data.taggedEnum<TestState>();

type TestEvent = Data.TaggedEnum<{
  Fetch: {};
  Resolve: { data: string };
  Reject: { message: string };
}>;
const Event = Data.taggedEnum<TestEvent>();

const testMachine = build(
  pipe(
    make<TestState, TestEvent>(State.Idle()),
    on(State.Idle, Event.Fetch, () => State.Loading()),
    on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
    on(State.Loading, Event.Reject, ({ event }) => State.Error({ message: event.message })),
    final(State.Success),
    final(State.Error),
  ),
);

describe("Testing", () => {
  describe("simulate", () => {
    test("returns all intermediate states", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* simulate(testMachine, [
            Event.Fetch(),
            Event.Resolve({ data: "hello" }),
          ]);

          expect(result.states.map((s) => s._tag)).toEqual(["Idle", "Loading", "Success"]);
          expect(result.finalState._tag).toBe("Success");
        }),
      );
    });

    test("handles events that don't cause transitions", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const result = yield* simulate(testMachine, [
            Event.Resolve({ data: "ignored" }), // No transition from Idle
          ]);

          expect(result.finalState._tag).toBe("Idle");
          expect(result.states).toHaveLength(1);
        }),
      );
    });
  });

  describe("createTestHarness", () => {
    test("provides step-by-step testing", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const harness = yield* createTestHarness(testMachine);

          let current = yield* harness.getState;
          expect(current._tag).toBe("Idle");

          yield* harness.send(Event.Fetch());
          current = yield* harness.getState;
          expect(current._tag).toBe("Loading");

          yield* harness.send(Event.Resolve({ data: "test" }));
          current = yield* harness.getState;
          expect(current._tag).toBe("Success");
        }),
      );
    });
  });

  describe("assertReaches", () => {
    test("passes when state is reached", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* assertReaches(
            testMachine,
            [Event.Fetch(), Event.Resolve({ data: "ok" })],
            "Success",
          );
        }),
      );
    });

    test("fails when state is not reached", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* assertReaches(testMachine, [Event.Fetch()], "Success");
        }).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    });
  });
});
