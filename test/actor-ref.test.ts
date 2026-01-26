// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Effect, Stream } from "effect";
import { describe, expect, test } from "bun:test";

import { ActorSystemDefault, ActorSystemService, Machine, yieldFibers } from "../src/index.js";

type TestState = Data.TaggedEnum<{
  Idle: {};
  Loading: { value: number };
  Active: { value: number };
  Done: {};
}>;
const State = Data.taggedEnum<TestState>();

type TestEvent = Data.TaggedEnum<{
  Start: { value: number };
  Complete: {};
  Update: { value: number };
  Stop: {};
}>;
const Event = Data.taggedEnum<TestEvent>();

const createTestMachine = () =>
  Machine.build(
    Machine.make<TestState, TestEvent>(State.Idle()).pipe(
      Machine.on(State.Idle, Event.Start, ({ event }) => State.Loading({ value: event.value })),
      Machine.on(State.Loading, Event.Complete, ({ state }) =>
        State.Active({ value: state.value }),
      ),
      Machine.on(State.Active, Event.Update, ({ event }) => State.Active({ value: event.value })),
      Machine.on(State.Active, Event.Stop, () => State.Done()),
      Machine.on(
        State.Active,
        Event.Update,
        ({ state }) => State.Active({ value: state.value * 2 }),
        {
          guard: ({ event }) => event.value > 100,
        },
      ),
      Machine.final(State.Done),
    ),
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

          yield* actor.send(Event.Start({ value: 42 }));
          yield* yieldFibers;

          const state2 = yield* actor.snapshot;
          expect(state2._tag).toBe("Loading");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("snapshotSync returns current state (sync)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const state = actor.snapshotSync();
          expect(state._tag).toBe("Idle");

          yield* actor.send(Event.Start({ value: 42 }));
          yield* yieldFibers;

          const state2 = actor.snapshotSync();
          expect(state2._tag).toBe("Loading");
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("matches / matchesSync", () => {
    test("matches checks state tag (Effect)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          expect(yield* actor.matches("Idle")).toBe(true);
          expect(yield* actor.matches("Loading")).toBe(false);

          yield* actor.send(Event.Start({ value: 10 }));
          yield* yieldFibers;

          expect(yield* actor.matches("Idle")).toBe(false);
          expect(yield* actor.matches("Loading")).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("matchesSync checks state tag (sync)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          expect(actor.matchesSync("Idle")).toBe(true);
          expect(actor.matchesSync("Loading")).toBe(false);

          yield* actor.send(Event.Start({ value: 10 }));
          yield* yieldFibers;

          expect(actor.matchesSync("Idle")).toBe(false);
          expect(actor.matchesSync("Loading")).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("can / canSync", () => {
    test("can returns true for valid transitions (Effect)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          // From Idle, can Start
          expect(yield* actor.can(Event.Start({ value: 1 }))).toBe(true);
          // From Idle, cannot Complete
          expect(yield* actor.can(Event.Complete())).toBe(false);
          // From Idle, cannot Stop
          expect(yield* actor.can(Event.Stop())).toBe(false);

          yield* actor.send(Event.Start({ value: 5 }));
          yield* yieldFibers;

          // Now in Loading
          expect(yield* actor.can(Event.Start({ value: 1 }))).toBe(false);
          expect(yield* actor.can(Event.Complete())).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("canSync returns true for valid transitions (sync)", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          expect(actor.canSync(Event.Start({ value: 1 }))).toBe(true);
          expect(actor.canSync(Event.Complete())).toBe(false);

          yield* actor.send(Event.Start({ value: 5 }));
          yield* yieldFibers;

          expect(actor.canSync(Event.Start({ value: 1 }))).toBe(false);
          expect(actor.canSync(Event.Complete())).toBe(true);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("can/canSync evaluates guards", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = Machine.build(
            Machine.make<TestState, TestEvent>(State.Active({ value: 0 })).pipe(
              Machine.on(
                State.Active,
                Event.Update,
                ({ event }) => State.Active({ value: event.value }),
                {
                  guard: ({ event }) => event.value < 10,
                },
              ),
              Machine.on(State.Active, Event.Stop, () => State.Done()),
              Machine.final(State.Done),
            ),
          );

          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          // Guard passes
          expect(yield* actor.can(Event.Update({ value: 5 }))).toBe(true);
          expect(actor.canSync(Event.Update({ value: 5 }))).toBe(true);

          // Guard fails
          expect(yield* actor.can(Event.Update({ value: 15 }))).toBe(false);
          expect(actor.canSync(Event.Update({ value: 15 }))).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("changes stream", () => {
    test("emits state updates", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const collected: string[] = [];

          // Fork a fiber to collect changes
          yield* Effect.fork(
            Stream.runForEach(Stream.take(actor.changes, 4), (state) =>
              Effect.sync(() => {
                collected.push(state._tag);
              }),
            ),
          );

          yield* actor.send(Event.Start({ value: 1 }));
          yield* yieldFibers;
          yield* actor.send(Event.Complete());
          yield* yieldFibers;
          yield* actor.send(Event.Stop());
          yield* yieldFibers;

          yield* Effect.yieldNow();

          // SubscriptionRef.changes emits updates (not initial value)
          expect(collected).toEqual(["Loading", "Active", "Done"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });

  describe("subscribe", () => {
    test("receives state updates", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const updates: string[] = [];
          actor.subscribe((state) => {
            updates.push(state._tag);
          });

          yield* actor.send(Event.Start({ value: 1 }));
          yield* yieldFibers;
          yield* actor.send(Event.Complete());
          yield* yieldFibers;

          expect(updates).toEqual(["Loading", "Active"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });

    test("unsubscribe stops updates", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const machine = createTestMachine();
          const system = yield* ActorSystemService;
          const actor = yield* system.spawn("test", machine);

          const updates: string[] = [];
          const unsub = actor.subscribe((state) => {
            updates.push(state._tag);
          });

          yield* actor.send(Event.Start({ value: 1 }));
          yield* yieldFibers;

          unsub();

          yield* actor.send(Event.Complete());
          yield* yieldFibers;

          // Only got the first update
          expect(updates).toEqual(["Loading"]);
        }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
      );
    });
  });
});
