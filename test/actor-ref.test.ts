// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, Stream } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Machine,
  yieldFibers,
  State,
  Event,
} from "../src/index.js";

const TestState = State({
  Idle: {},
  Loading: { value: Schema.Number },
  Active: { value: Schema.Number },
  Done: {},
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Start: { value: Schema.Number },
  Complete: {},
  Update: { value: Schema.Number },
  Stop: {},
});
type TestEvent = typeof TestEvent.Type;

const createTestMachine = () =>
  Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
    Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
      TestState.Loading({ value: event.value }),
    ),
    Machine.on(TestState.Loading, TestEvent.Complete, ({ state }) =>
      TestState.Active({ value: state.value }),
    ),
    Machine.on(TestState.Active, TestEvent.Update, ({ event }) =>
      TestState.Active({ value: event.value }),
    ),
    Machine.on(TestState.Active, TestEvent.Stop, () => TestState.Done()),
    Machine.on(
      TestState.Active,
      TestEvent.Update,
      ({ state }) => TestState.Active({ value: state.value * 2 }),
      {
        guard: ({ event }) => event.value > 100,
      },
    ),
    Machine.final(TestState.Done),
  );

describe("ActorRef ergonomics", () => {
  describe("snapshot / snapshotSync", () => {
    test("snapshot returns current state (Effect)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const state = yield* actor.snapshot;
          expect(state._tag).toBe("Idle");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("snapshotSync returns current state synchronously", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const state = actor.snapshotSync();
          expect(state._tag).toBe("Idle");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("snapshot updates after transitions", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          yield* actor.send(TestEvent.Start({ value: 42 }));
          yield* yieldFibers;

          const state = yield* actor.snapshot;
          expect(state._tag).toBe("Loading");
          expect((state as { value: number }).value).toBe(42);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("matches / matchesSync", () => {
    test("matches returns true for current state", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const isIdle = yield* actor.matches("Idle");
          expect(isIdle).toBe(true);

          const isLoading = yield* actor.matches("Loading");
          expect(isLoading).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("matchesSync returns synchronously", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          expect(actor.matchesSync("Idle")).toBe(true);
          expect(actor.matchesSync("Loading")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("matches updates after transitions", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          yield* actor.send(TestEvent.Start({ value: 10 }));
          yield* yieldFibers;

          expect(yield* actor.matches("Loading")).toBe(true);
          expect(yield* actor.matches("Idle")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("can / canSync", () => {
    test("can returns true when transition is possible", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          // In Idle state, can Start
          const canStart = yield* actor.can(TestEvent.Start({ value: 1 }));
          expect(canStart).toBe(true);

          // In Idle state, cannot Complete
          const canComplete = yield* actor.can(TestEvent.Complete());
          expect(canComplete).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("canSync returns synchronously", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          expect(actor.canSync(TestEvent.Start({ value: 1 }))).toBe(true);
          expect(actor.canSync(TestEvent.Complete())).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("can accounts for guards", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          // Transition to Active state
          yield* actor.send(TestEvent.Start({ value: 10 }));
          yield* yieldFibers;
          yield* actor.send(TestEvent.Complete());
          yield* yieldFibers;

          // Update with value <= 100 uses first handler (no guard)
          const canUpdateLow = yield* actor.can(TestEvent.Update({ value: 50 }));
          expect(canUpdateLow).toBe(true);

          // Update with value > 100 also matches (guard passes)
          const canUpdateHigh = yield* actor.can(TestEvent.Update({ value: 200 }));
          expect(canUpdateHigh).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("state (SubscriptionRef)", () => {
    test("state provides access to SubscriptionRef", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          // Access state directly
          const state = yield* actor.state;
          expect(state._tag).toBe("Idle");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("state changes stream emits on transitions", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const tags: string[] = [];

          // Start collecting changes in background
          yield* Effect.fork(
            actor.state.changes.pipe(
              Stream.take(3),
              Stream.tap((s) =>
                Effect.sync(() => {
                  tags.push(s._tag);
                }),
              ),
              Stream.runDrain,
            ),
          );

          // Make transitions
          yield* actor.send(TestEvent.Start({ value: 1 }));
          yield* yieldFibers;
          yield* actor.send(TestEvent.Complete());
          yield* yieldFibers;
          yield* actor.send(TestEvent.Stop());
          yield* yieldFibers;

          // Should have captured the transitions
          expect(tags).toContain("Loading");
          expect(tags).toContain("Active");
          expect(tags).toContain("Done");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("subscribe (sync)", () => {
    test("subscribe notifies on state changes", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const states: string[] = [];
          const unsubscribe = actor.subscribe((s) => states.push(s._tag));

          yield* actor.send(TestEvent.Start({ value: 1 }));
          yield* yieldFibers;
          yield* actor.send(TestEvent.Complete());
          yield* yieldFibers;

          expect(states).toContain("Loading");
          expect(states).toContain("Active");

          unsubscribe();
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("unsubscribe stops notifications", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const states: string[] = [];
          const unsubscribe = actor.subscribe((s) => states.push(s._tag));

          yield* actor.send(TestEvent.Start({ value: 1 }));
          yield* yieldFibers;

          unsubscribe();

          yield* actor.send(TestEvent.Complete());
          yield* yieldFibers;

          // Should only have Loading, not Active
          expect(states).toEqual(["Loading"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });
});
