// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Ref, Schema, Stream } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Machine,
  State,
  Event,
  Slot,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

// ============================================================================
// Shared Test Fixtures
// ============================================================================

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

const TestGuards = Slot.Guards({
  isHighValue: {},
});

const createTestMachine = () =>
  Machine.make({
    state: TestState,
    event: TestEvent,
    guards: TestGuards,
    initial: TestState.Idle,
  })
    .on(TestState.Idle, TestEvent.Start, ({ event }) => TestState.Loading({ value: event.value }))
    .on(TestState.Loading, TestEvent.Complete, ({ state }) =>
      TestState.Active({ value: state.value }),
    )
    .on(TestState.Active, TestEvent.Update, ({ event, guards }) =>
      Effect.gen(function* () {
        // If high value (> 100), double it
        if (yield* guards.isHighValue()) {
          return TestState.Active({ value: event.value * 2 });
        }
        return TestState.Active({ value: event.value });
      }),
    )
    .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
    .final(TestState.Done)
    .provide({
      isHighValue: (_params, { event }) => event._tag === "Update" && event.value > 100,
    });

// ============================================================================
// ActorSystem Tests
// ============================================================================

describe("ActorSystem", () => {
  it.scopedLive("spawns actors and processes events", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Update, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
        .final(TestState.Done);

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

      yield* actor.send(TestEvent.Stop);
      yield* yieldFibers;

      const state3 = yield* actor.state.get;
      expect(state3._tag).toBe("Done");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("stops actors properly", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Active({ value: event.value }),
      );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test-actor", machine);

      yield* actor.send(TestEvent.Start({ value: 5 }));
      yield* yieldFibers;

      // Verify actor is in expected state before stopping
      const stateBeforeStop = yield* actor.snapshot;
      expect(stateBeforeStop._tag).toBe("Active");

      yield* system.stop("test-actor");

      // Verify actor is no longer in system
      const actorAfterStop = yield* system.get("test-actor");
      expect(actorAfterStop._tag).toBe("None");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("duplicate spawn does not run effects", () =>
    Effect.gen(function* () {
      const SimpleState = State({ Idle: {} });
      const SimpleEvent = Event({ Ping: {} });
      const TestEffects = Slot.Effects({ mark: {} });

      const counter = yield* Ref.make(0);

      const machine = Machine.make({
        state: SimpleState,
        event: SimpleEvent,
        effects: TestEffects,
        initial: SimpleState.Idle,
      })
        .background(({ effects }) => effects.mark())
        .provide({
          mark: () => Ref.update(counter, (n) => n + 1),
        });

      const system = yield* ActorSystemService;
      yield* system.spawn("dup-actor", machine);
      yield* yieldFibers;

      const result = yield* Effect.either(system.spawn("dup-actor", machine));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("DuplicateActorError");
      }

      yield* yieldFibers;
      const count = yield* Ref.get(counter);
      expect(count).toBe(1);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("fails spawn when slots are unprovided", () =>
    Effect.gen(function* () {
      const SimpleState = State({ Idle: {} });
      const SimpleEvent = Event({ Ping: {} });
      const TestEffects = Slot.Effects({ mark: {} });

      const machine = Machine.make({
        state: SimpleState,
        event: SimpleEvent,
        effects: TestEffects,
        initial: SimpleState.Idle,
      });

      const system = yield* ActorSystemService;
      const result = yield* Effect.either(system.spawn("missing-slots", machine));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("UnprovidedSlotsError");
      }
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("listener errors do not break event loop", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Stop, () => TestState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("listener-actor", machine);

      actor.subscribe(() => {
        throw new Error("boom");
      });

      yield* actor.send(TestEvent.Start({ value: 1 }));
      yield* yieldFibers;

      yield* actor.send(TestEvent.Stop);
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Done");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

// ============================================================================
// Machine.spawn Tests (simple API without ActorSystem)
// ============================================================================

describe("Machine.spawn", () => {
  it.scopedLive("spawns actor without ActorSystem", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
        .final(TestState.Done);

      // No ActorSystemService needed!
      const actor = yield* Machine.spawn(machine);

      yield* actor.send(TestEvent.Start({ value: 42 }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
      if (state._tag === "Active") {
        expect(state.value).toBe(42);
      }
    }),
  );

  it.scopedLive("spawns actor with custom ID", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Active({ value: event.value }),
      );

      const actor = yield* Machine.spawn(machine, "my-custom-id");

      expect(actor.id).toBe("my-custom-id");
    }),
  );

  it.scopedLive("auto-generates ID when not provided", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      });

      const actor = yield* Machine.spawn(machine);

      expect(actor.id).toMatch(/^actor-/);
    }),
  );

  it.scopedLive("cleans up on scope close", () =>
    Effect.gen(function* () {
      const cleanedUp: string[] = [];

      const TestEffects = Slot.Effects({ track: {} });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        effects: TestEffects,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ value: event.value }),
        )
        .spawn(TestState.Active, ({ effects }) => effects.track())
        .provide({
          track: () => Effect.addFinalizer(() => Effect.sync(() => cleanedUp.push("cleaned"))),
        });

      // Run in inner scope
      yield* Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* Machine.spawn(machine);
          yield* actor.send(TestEvent.Start({ value: 1 }));
          yield* yieldFibers;
          expect(cleanedUp).toEqual([]);
        }),
      );

      // After scope closes, finalizer should have run
      expect(cleanedUp).toEqual(["cleaned"]);
    }),
  );
});

// ============================================================================
// ActorRef Tests
// ============================================================================

describe("ActorRef", () => {
  describe("snapshot / snapshotSync", () => {
    it.scopedLive("snapshot returns current state (Effect)", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Idle");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("snapshotSync returns current state synchronously", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        const state = actor.snapshotSync();
        expect(state._tag).toBe("Idle");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("snapshot updates after transitions", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Start({ value: 42 }));
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Loading");
        expect((state as { value: number }).value).toBe(42);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("matches / matchesSync", () => {
    it.scopedLive("matches returns true for current state", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        const isIdle = yield* actor.matches("Idle");
        expect(isIdle).toBe(true);

        const isLoading = yield* actor.matches("Loading");
        expect(isLoading).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("matchesSync returns synchronously", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        expect(actor.matchesSync("Idle")).toBe(true);
        expect(actor.matchesSync("Loading")).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("matches updates after transitions", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Start({ value: 10 }));
        yield* yieldFibers;

        expect(yield* actor.matches("Loading")).toBe(true);
        expect(yield* actor.matches("Idle")).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("can / canSync", () => {
    it.scopedLive("can returns true when transition is possible", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        // In Idle state, can Start
        const canStart = yield* actor.can(TestEvent.Start({ value: 1 }));
        expect(canStart).toBe(true);

        // In Idle state, cannot Complete
        const canComplete = yield* actor.can(TestEvent.Complete);
        expect(canComplete).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("canSync returns synchronously", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        expect(actor.canSync(TestEvent.Start({ value: 1 }))).toBe(true);
        expect(actor.canSync(TestEvent.Complete)).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("can accounts for guards", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        // Transition to Active state
        yield* actor.send(TestEvent.Start({ value: 10 }));
        yield* yieldFibers;
        yield* actor.send(TestEvent.Complete);
        yield* yieldFibers;

        // Update with value <= 100 uses regular path
        const canUpdateLow = yield* actor.can(TestEvent.Update({ value: 50 }));
        expect(canUpdateLow).toBe(true);

        // Update with value > 100 also works (uses high value path)
        const canUpdateHigh = yield* actor.can(TestEvent.Update({ value: 200 }));
        expect(canUpdateHigh).toBe(true);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("state (SubscriptionRef)", () => {
    it.scopedLive("state provides access to SubscriptionRef", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        // Access state directly
        const state = yield* actor.state;
        expect(state._tag).toBe("Idle");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("state changes stream emits on transitions", () =>
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
        yield* actor.send(TestEvent.Complete);
        yield* yieldFibers;
        yield* actor.send(TestEvent.Stop);
        yield* yieldFibers;

        // Should have captured the transitions
        expect(tags).toContain("Loading");
        expect(tags).toContain("Active");
        expect(tags).toContain("Done");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("subscribe (sync)", () => {
    it.scopedLive("subscribe notifies on state changes", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        const states: string[] = [];
        const unsubscribe = actor.subscribe((s) => states.push(s._tag));

        yield* actor.send(TestEvent.Start({ value: 1 }));
        yield* yieldFibers;
        yield* actor.send(TestEvent.Complete);
        yield* yieldFibers;

        expect(states).toContain("Loading");
        expect(states).toContain("Active");

        unsubscribe();
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("unsubscribe stops notifications", () =>
      Effect.gen(function* () {
        const machine = createTestMachine();
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        const states: string[] = [];
        const unsubscribe = actor.subscribe((s) => states.push(s._tag));

        yield* actor.send(TestEvent.Start({ value: 1 }));
        yield* yieldFibers;

        unsubscribe();

        yield* actor.send(TestEvent.Complete);
        yield* yieldFibers;

        // Should only have Loading, not Active
        expect(states).toEqual(["Loading"]);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });
});
