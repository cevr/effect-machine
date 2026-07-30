import { Effect, Schema } from "effect";

import {
  assertNeverReaches,
  assertPath,
  assertReaches,
  createTestHarness,
  Machine,
  simulate,
  State,
  Event,
} from "../src/index.js";
import { describe, expect, it } from "effect-bun-test/v3";

const TestState = State({
  Idle: {},
  Loading: {},
  Success: { data: Schema.String },
  Error: { message: Schema.String },
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Fetch: {},
  Resolve: { data: Schema.String },
  Reject: { message: Schema.String },
});
type TestEvent = typeof TestEvent.Type;

const testMachine = Machine.make({
  state: TestState,
  event: TestEvent,
  initial: TestState.Idle,
})
  .on(TestState.Idle, TestEvent.Fetch, () => TestState.Loading)
  .on(TestState.Loading, TestEvent.Resolve, ({ event }) => TestState.Success({ data: event.data }))
  .on(TestState.Loading, TestEvent.Reject, ({ event }) =>
    TestState.Error({ message: event.message }),
  )
  .final(TestState.Success)
  .final(TestState.Error);

describe("Testing", () => {
  describe("simulate", () => {
    it.scopedLive("returns all intermediate states", () =>
      Effect.gen(function* () {
        const result = yield* simulate(testMachine, [
          TestEvent.Fetch,
          TestEvent.Resolve({ data: "hello" }),
        ]);

        expect(result.states.map((s) => s._tag)).toEqual(["Idle", "Loading", "Success"]);
        expect(result.finalState._tag).toBe("Success");
      }),
    );

    it.scopedLive("handles events that don't cause transitions", () =>
      Effect.gen(function* () {
        const result = yield* simulate(testMachine, [
          TestEvent.Resolve({ data: "ignored" }), // No transition from Idle
        ]);

        expect(result.finalState._tag).toBe("Idle");
        expect(result.states).toHaveLength(1);
      }),
    );
  });

  describe("createTestHarness", () => {
    it.scopedLive("provides step-by-step testing", () =>
      Effect.gen(function* () {
        const harness = yield* createTestHarness(testMachine);

        let current = yield* harness.getState;
        expect(current._tag).toBe("Idle");

        yield* harness.send(TestEvent.Fetch);
        current = yield* harness.getState;
        expect(current._tag).toBe("Loading");

        yield* harness.send(TestEvent.Resolve({ data: "test" }));
        current = yield* harness.getState;
        expect(current._tag).toBe("Success");
      }),
    );
  });

  describe("assertReaches", () => {
    it.scopedLive("passes when state is reached", () =>
      Effect.gen(function* () {
        const result = yield* assertReaches(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          "Success",
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails when state is not reached", () =>
      Effect.gen(function* () {
        const result = yield* assertReaches(testMachine, [TestEvent.Fetch], "Success").pipe(
          Effect.exit,
        );

        expect(result._tag).toBe("Failure");
      }),
    );
  });

  describe("assertPath", () => {
    it.scopedLive("passes when path matches", () =>
      Effect.gen(function* () {
        const result = yield* assertPath(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          ["Idle", "Loading", "Success"],
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails on path mismatch", () =>
      Effect.gen(function* () {
        const result = yield* assertPath(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          ["Idle", "Success"], // Wrong path
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Failure");
      }),
    );

    it.scopedLive("fails on wrong state in path", () =>
      Effect.gen(function* () {
        const result = yield* assertPath(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          ["Idle", "Loading", "Error"], // Wrong final state
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Failure");
      }),
    );
  });

  describe("assertNeverReaches", () => {
    it.scopedLive("passes when forbidden state is not reached", () =>
      Effect.gen(function* () {
        const result = yield* assertNeverReaches(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          "Error",
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails when forbidden state is reached", () =>
      Effect.gen(function* () {
        const result = yield* assertNeverReaches(
          testMachine,
          [TestEvent.Fetch, TestEvent.Reject({ message: "oops" })],
          "Error",
        ).pipe(Effect.exit);

        expect(result._tag).toBe("Failure");
      }),
    );
  });

  describe("createTestHarness with onTransition", () => {
    it.scopedLive("calls onTransition observer", () =>
      Effect.gen(function* () {
        const transitions: Array<{ from: string; event: string; to: string }> = [];

        const harness = yield* createTestHarness(testMachine, {
          onTransition: (from, event, to) =>
            transitions.push({ from: from._tag, event: event._tag, to: to._tag }),
        });

        yield* harness.send(TestEvent.Fetch);
        yield* harness.send(TestEvent.Resolve({ data: "test" }));

        expect(transitions).toEqual([
          { from: "Idle", event: "Fetch", to: "Loading" },
          { from: "Loading", event: "Resolve", to: "Success" },
        ]);
      }),
    );
  });
});
