// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Ref, Schema } from "effect";

import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "../../src/index.js";
import { describe, expect, it, test, yieldFibers } from "../utils/effect-test.js";

describe("invoke", () => {
  describe("parallel invokes", () => {
    const TestState = State({
      Idle: {},
      Running: {},
      Done: {},
    });

    const TestEvent = Event({
      Start: {},
      FirstDone: {},
      SecondDone: {},
      Stop: {},
    });

    test("array syntax registers multiple effect slots", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).invoke(TestState.Running, ["firstTask", "secondTask"] as const);

      expect(machine.effectSlots.size).toBe(2);
      expect(machine.effectSlots.has("firstTask")).toBe(true);
      expect(machine.effectSlots.has("secondTask")).toBe(true);

      const firstSlot = machine.effectSlots.get("firstTask");
      expect(firstSlot?.type).toBe("invoke");
      expect(firstSlot?.stateTag).toBe("Running");

      const secondSlot = machine.effectSlots.get("secondTask");
      expect(secondSlot?.type).toBe("invoke");
      expect(secondSlot?.stateTag).toBe("Running");
    });

    it.scopedLive("parallel invokes both start on state entry", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Start, () => TestState.Running)
          .on(TestState.Running, TestEvent.Stop, () => TestState.Done)
          .invoke(TestState.Running, ["firstTask", "secondTask"])
          .final(TestState.Done)
          .provide({
            firstTask: () =>
              Effect.gen(function* () {
                log.push("first:start");
                yield* Effect.sleep("10 seconds");
                log.push("first:done");
              }),
            secondTask: () =>
              Effect.gen(function* () {
                log.push("second:start");
                yield* Effect.sleep("10 seconds");
                log.push("second:done");
              }),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Start);
        yield* yieldFibers;

        // Both should have started
        expect(log).toEqual(["first:start", "second:start"]);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("parallel invokes both interrupted on state exit", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Start, () => TestState.Running)
          .on(TestState.Running, TestEvent.Stop, () => TestState.Done)
          .invoke(TestState.Running, ["firstTask", "secondTask"] as const)
          .final(TestState.Done)
          .provide({
            firstTask: () =>
              Effect.gen(function* () {
                log.push("first:start");
                yield* Effect.sleep("10 seconds");
                log.push("first:done");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("first:interrupted")))),
            secondTask: () =>
              Effect.gen(function* () {
                log.push("second:start");
                yield* Effect.sleep("10 seconds");
                log.push("second:done");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("second:interrupted")))),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Start);
        yield* yieldFibers;

        expect(log).toEqual(["first:start", "second:start"]);

        yield* actor.send(TestEvent.Stop);
        yield* yieldFibers;

        expect(log).toContain("first:interrupted");
        expect(log).toContain("second:interrupted");
        expect(log).not.toContain("first:done");
        expect(log).not.toContain("second:done");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("root-level invoke", () => {
    const TestState = State({
      Idle: {},
      Active: {},
      Done: {},
    });

    const TestEvent = Event({
      Activate: {},
      Finish: {},
      BackgroundEvent: { data: Schema.String },
    });

    test("root invoke slot has null stateTag", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).invoke("backgroundTask");

      expect(machine.effectSlots.size).toBe(1);
      const slot = machine.effectSlots.get("backgroundTask");
      expect(slot?.type).toBe("invoke");
      expect(slot?.stateTag).toBeNull();
    });

    it.scopedLive("root invoke starts on actor spawn", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Activate, () => TestState.Active)
          .invoke("backgroundTask")
          .provide({
            backgroundTask: () =>
              Effect.gen(function* () {
                log.push("background:start");
                yield* Effect.sleep("10 seconds");
                log.push("background:done");
              }),
          });

        const system = yield* ActorSystemService;
        yield* system.spawn("test", machine);
        yield* yieldFibers;

        // Background task should start immediately on spawn
        expect(log).toEqual(["background:start"]);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("root invoke runs across state transitions", () =>
      Effect.gen(function* () {
        const counterRef = yield* Ref.make(0);

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Activate, () => TestState.Active)
          .on(TestState.Active, TestEvent.Finish, () => TestState.Done)
          .invoke("counter")
          .final(TestState.Done)
          .provide({
            counter: () =>
              Effect.gen(function* () {
                // Increment counter in a loop
                while (true) {
                  yield* Ref.update(counterRef, (n) => n + 1);
                  yield* Effect.sleep("1 millis");
                }
              }),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        // Let it run a bit
        yield* Effect.sleep("10 millis");

        // Transition states
        yield* actor.send(TestEvent.Activate);
        yield* yieldFibers;

        yield* Effect.sleep("10 millis");

        const countBeforeFinish = yield* Ref.get(counterRef);

        // Finish (final state)
        yield* actor.send(TestEvent.Finish);
        yield* yieldFibers;

        // Should have accumulated counts through both states
        expect(countBeforeFinish).toBeGreaterThan(5);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("root invoke interrupted on actor stop", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
          .invoke("backgroundTask")
          .final(TestState.Done)
          .provide({
            backgroundTask: () =>
              Effect.gen(function* () {
                log.push("background:start");
                yield* Effect.sleep("10 seconds");
                log.push("background:done");
              }).pipe(
                Effect.onInterrupt(() => Effect.sync(() => log.push("background:interrupted"))),
              ),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);
        yield* yieldFibers;

        expect(log).toEqual(["background:start"]);

        yield* actor.stop;
        yield* yieldFibers;

        expect(log).toContain("background:interrupted");
        expect(log).not.toContain("background:done");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("root invoke can send events to machine", () =>
      Effect.gen(function* () {
        const receivedData: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.BackgroundEvent, ({ event }) => {
            receivedData.push(event.data);
            return TestState.Idle;
          })
          .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
          .invoke("emitter")
          .final(TestState.Done)
          .provide({
            emitter: ({ self }) =>
              Effect.gen(function* () {
                yield* self.send(TestEvent.BackgroundEvent({ data: "first" }));
                yield* Effect.sleep("1 millis");
                yield* self.send(TestEvent.BackgroundEvent({ data: "second" }));
                yield* Effect.sleep("1 millis");
                yield* self.send(TestEvent.BackgroundEvent({ data: "third" }));
              }),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        // Wait for events to be processed
        yield* Effect.sleep("10 millis");
        yield* yieldFibers;

        expect(receivedData).toEqual(["first", "second", "third"]);

        yield* actor.send(TestEvent.Finish);
        yield* yieldFibers;
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("root invoke interrupted when reaching final state", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
          .invoke("backgroundTask")
          .final(TestState.Done)
          .provide({
            backgroundTask: () =>
              Effect.gen(function* () {
                log.push("background:start");
                yield* Effect.sleep("10 seconds");
                log.push("background:done");
              }).pipe(
                Effect.onInterrupt(() => Effect.sync(() => log.push("background:interrupted"))),
              ),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);
        yield* yieldFibers;

        expect(log).toEqual(["background:start"]);

        // Transition to final state
        yield* actor.send(TestEvent.Finish);
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Done");
        expect(log).toContain("background:interrupted");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("mixed invokes", () => {
    const TestState = State({
      Idle: {},
      Loading: {},
      Done: {},
    });

    const TestEvent = Event({
      Start: {},
      Finish: {},
    });

    it.scopedLive("root + state-scoped invokes work together", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Start, () => TestState.Loading)
          .on(TestState.Loading, TestEvent.Finish, () => TestState.Done)
          .invoke("rootTask")
          .invoke(TestState.Loading, "loadingTask")
          .final(TestState.Done)
          .provide({
            rootTask: () =>
              Effect.gen(function* () {
                log.push("root:start");
                yield* Effect.sleep("10 seconds");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("root:interrupted")))),
            loadingTask: () =>
              Effect.gen(function* () {
                log.push("loading:start");
                yield* Effect.sleep("10 seconds");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("loading:interrupted")))),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);
        yield* yieldFibers;

        // Root task starts immediately
        expect(log).toEqual(["root:start"]);

        // Enter Loading state
        yield* actor.send(TestEvent.Start);
        yield* yieldFibers;

        // Both root and loading tasks running
        expect(log).toContain("root:start");
        expect(log).toContain("loading:start");

        // Finish to Done
        yield* actor.send(TestEvent.Finish);
        yield* yieldFibers;

        // Loading task interrupted, root still running until actor stops
        expect(log).toContain("loading:interrupted");

        // Stop actor
        yield* actor.stop;
        yield* yieldFibers;

        expect(log).toContain("root:interrupted");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("parallel root invokes", () => {
    const TestState = State({
      Idle: {},
      Done: {},
    });

    const TestEvent = Event({
      Finish: {},
    });

    test("array syntax registers multiple root slots", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).invoke(["firstRoot", "secondRoot"] as const);

      expect(machine.effectSlots.size).toBe(2);
      expect(machine.effectSlots.has("firstRoot")).toBe(true);
      expect(machine.effectSlots.has("secondRoot")).toBe(true);

      const firstSlot = machine.effectSlots.get("firstRoot");
      expect(firstSlot?.type).toBe("invoke");
      expect(firstSlot?.stateTag).toBeNull();

      const secondSlot = machine.effectSlots.get("secondRoot");
      expect(secondSlot?.type).toBe("invoke");
      expect(secondSlot?.stateTag).toBeNull();
    });

    it.scopedLive("parallel root invokes both start on spawn", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
          .invoke(["firstRoot", "secondRoot"] as const)
          .final(TestState.Done)
          .provide({
            firstRoot: () =>
              Effect.gen(function* () {
                log.push("first:start");
                yield* Effect.sleep("10 seconds");
                log.push("first:done");
              }),
            secondRoot: () =>
              Effect.gen(function* () {
                log.push("second:start");
                yield* Effect.sleep("10 seconds");
                log.push("second:done");
              }),
          });

        const system = yield* ActorSystemService;
        yield* system.spawn("test", machine);
        yield* yieldFibers;

        expect(log).toEqual(["first:start", "second:start"]);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("parallel root invokes both interrupted on stop", () =>
      Effect.gen(function* () {
        const log: string[] = [];

        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Idle,
        })
          .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
          .invoke(["firstRoot", "secondRoot"] as const)
          .final(TestState.Done)
          .provide({
            firstRoot: () =>
              Effect.gen(function* () {
                log.push("first:start");
                yield* Effect.sleep("10 seconds");
                log.push("first:done");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("first:interrupted")))),
            secondRoot: () =>
              Effect.gen(function* () {
                log.push("second:start");
                yield* Effect.sleep("10 seconds");
                log.push("second:done");
              }).pipe(Effect.onInterrupt(() => Effect.sync(() => log.push("second:interrupted")))),
          });

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);
        yield* yieldFibers;

        expect(log).toEqual(["first:start", "second:start"]);

        yield* actor.stop;
        yield* yieldFibers;

        expect(log).toContain("first:interrupted");
        expect(log).toContain("second:interrupted");
        expect(log).not.toContain("first:done");
        expect(log).not.toContain("second:done");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });
});
