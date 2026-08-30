import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

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

    it.scopedLive("drains postponed events through multiple state changes", () =>
      Effect.gen(function* () {
        const CascadeState = State({ A: {}, B: {}, C: {}, Done: {} });
        const CascadeEvent = Event({ GoB: {}, GoC: {}, Finish: {} });
        const machine = Machine.make({
          state: CascadeState,
          event: CascadeEvent,
          initial: CascadeState.A,
        })
          .on(CascadeState.A, CascadeEvent.GoB, () => CascadeState.B)
          .on(CascadeState.B, CascadeEvent.GoC, () => CascadeState.C)
          .on(CascadeState.C, CascadeEvent.Finish, () => CascadeState.Done)
          .postpone(CascadeState.A, [CascadeEvent.GoC, CascadeEvent.Finish])
          .postpone(CascadeState.B, CascadeEvent.Finish)
          .final(CascadeState.Done);
        const harness = yield* createTestHarness(machine);

        yield* harness.send(CascadeEvent.Finish);
        yield* harness.send(CascadeEvent.GoC);
        const state = yield* harness.send(CascadeEvent.GoB);

        expect(state._tag).toBe("Done");
      }),
    );

    it.scopedLive("does not process events after a final state", () =>
      Effect.gen(function* () {
        const transitions: string[] = [];
        const harness = yield* createTestHarness(testMachine, {
          onTransition: (_from, event) => transitions.push(event._tag),
        });

        yield* harness.send(TestEvent.Fetch);
        yield* harness.send(TestEvent.Resolve({ data: "done" }));
        const state = yield* harness.send(TestEvent.Reject({ message: "late" }));

        expect(state._tag).toBe("Success");
        expect(transitions).toEqual(["Fetch", "Resolve"]);
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
        ).pipe(Effect.result);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails when state is not reached", () =>
      Effect.gen(function* () {
        const result = yield* assertReaches(testMachine, [TestEvent.Fetch], "Success").pipe(
          Effect.result,
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
        ).pipe(Effect.result);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails on path mismatch", () =>
      Effect.gen(function* () {
        const result = yield* assertPath(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          ["Idle", "Success"], // Wrong path
        ).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
      }),
    );

    it.scopedLive("fails on wrong state in path", () =>
      Effect.gen(function* () {
        const result = yield* assertPath(
          testMachine,
          [TestEvent.Fetch, TestEvent.Resolve({ data: "ok" })],
          ["Idle", "Loading", "Error"], // Wrong final state
        ).pipe(Effect.result);

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
        ).pipe(Effect.result);

        expect(result._tag).toBe("Success");
      }),
    );

    it.scopedLive("fails when forbidden state is reached", () =>
      Effect.gen(function* () {
        const result = yield* assertNeverReaches(
          testMachine,
          [TestEvent.Fetch, TestEvent.Reject({ message: "oops" })],
          "Error",
        ).pipe(Effect.result);

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
