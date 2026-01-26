import { Data, Effect } from "effect";
import { describe, expect, test } from "bun:test";

import {
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  Machine,
  simulate,
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

const testMachine = Machine.build(
  Machine.make<TestState, TestEvent>(State.Idle()).pipe(
    Machine.on(State.Idle, Event.Fetch, () => State.Loading()),
    Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
    Machine.on(State.Loading, Event.Reject, ({ event }) => State.Error({ message: event.message })),
    Machine.final(State.Success),
    Machine.final(State.Error),
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
        assertReaches(testMachine, [Event.Fetch(), Event.Resolve({ data: "ok" })], "Success"),
      );
    });

    test("fails when state is not reached", async () => {
      const result = await Effect.runPromise(
        assertReaches(testMachine, [Event.Fetch()], "Success").pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("assertPath", () => {
    test("passes when path matches", async () => {
      await Effect.runPromise(
        assertPath(
          testMachine,
          [Event.Fetch(), Event.Resolve({ data: "ok" })],
          ["Idle", "Loading", "Success"],
        ),
      );
    });

    test("fails on path mismatch", async () => {
      const result = await Effect.runPromise(
        assertPath(
          testMachine,
          [Event.Fetch(), Event.Resolve({ data: "ok" })],
          ["Idle", "Success"], // Wrong path
        ).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    });

    test("fails on wrong state in path", async () => {
      const result = await Effect.runPromise(
        assertPath(
          testMachine,
          [Event.Fetch(), Event.Resolve({ data: "ok" })],
          ["Idle", "Loading", "Error"], // Wrong final state
        ).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("assertNeverReaches", () => {
    test("passes when forbidden state is not reached", async () => {
      await Effect.runPromise(
        assertNeverReaches(testMachine, [Event.Fetch(), Event.Resolve({ data: "ok" })], "Error"),
      );
    });

    test("fails when forbidden state is reached", async () => {
      const result = await Effect.runPromise(
        assertNeverReaches(
          testMachine,
          [Event.Fetch(), Event.Reject({ message: "oops" })],
          "Error",
        ).pipe(Effect.either),
      );

      expect(result._tag).toBe("Left");
    });
  });

  describe("createTestHarness with onTransition", () => {
    test("calls onTransition observer", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const transitions: Array<{ from: string; event: string; to: string }> = [];

          const harness = yield* createTestHarness(testMachine, {
            onTransition: (from, event, to) =>
              transitions.push({ from: from._tag, event: event._tag, to: to._tag }),
          });

          yield* harness.send(Event.Fetch());
          yield* harness.send(Event.Resolve({ data: "test" }));

          expect(transitions).toEqual([
            { from: "Idle", event: "Fetch", to: "Loading" },
            { from: "Loading", event: "Resolve", to: "Success" },
          ]);
        }),
      );
    });
  });
});
