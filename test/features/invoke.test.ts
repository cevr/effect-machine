// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Ref, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

describe("invoke", () => {
  describe("parallel invokes", () => {
    const TestState = State({
      Idle: {},
      Running: {},
      Done: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Start: {},
      FirstDone: {},
      SecondDone: {},
      Stop: {},
    });
    type TestEvent = typeof TestEvent.Type;

    test("array syntax registers multiple effect slots", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle(),
      }).pipe(Machine.invoke(TestState.Running, ["firstTask", "secondTask"] as const));

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

    test("parallel invokes both start on state entry", async () => {
      const log: string[] = [];

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle(),
      }).pipe(
        Machine.on(TestState.Idle, TestEvent.Start, () => TestState.Running()),
        Machine.on(TestState.Running, TestEvent.Stop, () => TestState.Done()),
        Machine.invoke(TestState.Running, ["firstTask", "secondTask"]),
        Machine.final(TestState.Done),
      );

      const provided = Machine.provide(machine, {
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

      await Effect.runPromise(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", provided);

          yield* actor.send(TestEvent.Start());
          yield* yieldFibers;

          // Both should have started
          expect(log).toEqual(["first:start", "second:start"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("parallel invokes both interrupted on state exit", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Start, () => TestState.Running()),
            Machine.on(TestState.Running, TestEvent.Stop, () => TestState.Done()),
            Machine.invoke(TestState.Running, ["firstTask", "secondTask"] as const),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);

          yield* actor.send(TestEvent.Start());
          yield* yieldFibers;

          expect(log).toEqual(["first:start", "second:start"]);

          yield* actor.send(TestEvent.Stop());
          yield* yieldFibers;

          expect(log).toContain("first:interrupted");
          expect(log).toContain("second:interrupted");
          expect(log).not.toContain("first:done");
          expect(log).not.toContain("second:done");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("root-level invoke", () => {
    const TestState = State({
      Idle: {},
      Active: {},
      Done: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Activate: {},
      Finish: {},
      BackgroundEvent: { data: Schema.String },
    });
    type TestEvent = typeof TestEvent.Type;

    test("root invoke slot has null stateTag", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle(),
      }).pipe(Machine.invoke("backgroundTask"));

      expect(machine.effectSlots.size).toBe(1);
      const slot = machine.effectSlots.get("backgroundTask");
      expect(slot?.type).toBe("invoke");
      expect(slot?.stateTag).toBeNull();
    });

    test("root invoke starts on actor spawn", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Activate, () => TestState.Active()),
            Machine.invoke("backgroundTask"),
          );

          const provided = Machine.provide(machine, {
            backgroundTask: () =>
              Effect.gen(function* () {
                log.push("background:start");
                yield* Effect.sleep("10 seconds");
                log.push("background:done");
              }),
          });

          const system = yield* ActorSystemService;
          yield* system.spawn("test", provided);
          yield* yieldFibers;

          // Background task should start immediately on spawn
          expect(log).toEqual(["background:start"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("root invoke runs across state transitions", async () => {
      const counter = await Effect.runPromise(
        Effect.gen(function* () {
          const counterRef = yield* Ref.make(0);

          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Activate, () => TestState.Active()),
            Machine.on(TestState.Active, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke("counter"),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);

          // Let it run a bit
          yield* Effect.sleep("10 millis");

          // Transition states
          yield* actor.send(TestEvent.Activate());
          yield* yieldFibers;

          yield* Effect.sleep("10 millis");

          const countBeforeFinish = yield* Ref.get(counterRef);

          // Finish (final state)
          yield* actor.send(TestEvent.Finish());
          yield* yieldFibers;

          // Should have accumulated counts through both states
          return countBeforeFinish;
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );

      // Counter should have incremented multiple times across states
      expect(counter).toBeGreaterThan(5);
    });

    test("root invoke interrupted on actor stop", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke("backgroundTask"),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);
          yield* yieldFibers;

          expect(log).toEqual(["background:start"]);

          yield* actor.stop;
          yield* yieldFibers;

          expect(log).toContain("background:interrupted");
          expect(log).not.toContain("background:done");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("root invoke can send events to machine", async () => {
      const receivedData: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.BackgroundEvent, ({ event }) => {
              receivedData.push(event.data);
              return TestState.Idle();
            }),
            Machine.on(TestState.Idle, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke("emitter"),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);

          // Wait for events to be processed
          yield* Effect.sleep("10 millis");
          yield* yieldFibers;

          expect(receivedData).toEqual(["first", "second", "third"]);

          yield* actor.send(TestEvent.Finish());
          yield* yieldFibers;
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("root invoke interrupted when reaching final state", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke("backgroundTask"),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);
          yield* yieldFibers;

          expect(log).toEqual(["background:start"]);

          // Transition to final state
          yield* actor.send(TestEvent.Finish());
          yield* yieldFibers;

          const state = yield* actor.snapshot;
          expect(state._tag).toBe("Done");
          expect(log).toContain("background:interrupted");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("mixed invokes", () => {
    const TestState = State({
      Idle: {},
      Loading: {},
      Done: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Start: {},
      Finish: {},
    });
    type TestEvent = typeof TestEvent.Type;

    test("root + state-scoped invokes work together", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Start, () => TestState.Loading()),
            Machine.on(TestState.Loading, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke("rootTask"),
            Machine.invoke(TestState.Loading, "loadingTask"),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);
          yield* yieldFibers;

          // Root task starts immediately
          expect(log).toEqual(["root:start"]);

          // Enter Loading state
          yield* actor.send(TestEvent.Start());
          yield* yieldFibers;

          // Both root and loading tasks running
          expect(log).toContain("root:start");
          expect(log).toContain("loading:start");

          // Finish to Done
          yield* actor.send(TestEvent.Finish());
          yield* yieldFibers;

          // Loading task interrupted, root still running until actor stops
          expect(log).toContain("loading:interrupted");

          // Stop actor
          yield* actor.stop;
          yield* yieldFibers;

          expect(log).toContain("root:interrupted");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("parallel root invokes", () => {
    const TestState = State({
      Idle: {},
      Done: {},
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Finish: {},
    });
    type TestEvent = typeof TestEvent.Type;

    test("array syntax registers multiple root slots", () => {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle(),
      }).pipe(Machine.invoke(["firstRoot", "secondRoot"] as const));

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

    test("parallel root invokes both start on spawn", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke(["firstRoot", "secondRoot"] as const),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          yield* system.spawn("test", provided);
          yield* yieldFibers;

          expect(log).toEqual(["first:start", "second:start"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("parallel root invokes both interrupted on stop", async () => {
      const log: string[] = [];

      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.make({
            state: TestState,
            event: TestEvent,
            initial: TestState.Idle(),
          }).pipe(
            Machine.on(TestState.Idle, TestEvent.Finish, () => TestState.Done()),
            Machine.invoke(["firstRoot", "secondRoot"] as const),
            Machine.final(TestState.Done),
          );

          const provided = Machine.provide(machine, {
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
          const actor = yield* system.spawn("test", provided);
          yield* yieldFibers;

          expect(log).toEqual(["first:start", "second:start"]);

          yield* actor.stop;
          yield* yieldFibers;

          expect(log).toContain("first:interrupted");
          expect(log).toContain("second:interrupted");
          expect(log).not.toContain("first:done");
          expect(log).not.toContain("second:done");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });
});
