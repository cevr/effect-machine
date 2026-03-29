// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

// ============================================================================
// Shared Test Fixtures
// ============================================================================

const TestState = State({
  Idle: {},
  Active: { value: Schema.Number },
  Done: {},
});

const TestEvent = Event({
  Start: { value: Schema.Number },
  Update: { value: Schema.Number },
  Stop: {},
  Unknown: {},
});

const createMachine = () =>
  Machine.make({
    state: TestState,
    event: TestEvent,
    initial: TestState.Idle,
  })
    .on(TestState.Idle, TestEvent.Start, ({ event }) => TestState.Active({ value: event.value }))
    .on(TestState.Active, TestEvent.Update, ({ event }) => TestState.Active({ value: event.value }))
    .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
    .final(TestState.Done);

// ============================================================================
// call Tests
// ============================================================================

describe("ActorRef.call", () => {
  it.scopedLive("returns ProcessEventResult for matching transition", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-match", machine);

      const result = yield* actor.call(TestEvent.Start({ value: 42 }));

      expect(result.transitioned).toBe(true);
      expect(result.previousState._tag).toBe("Idle");
      expect(result.newState._tag).toBe("Active");
      expect(result.lifecycleRan).toBe(true);
      expect(result.isFinal).toBe(false);

      // State should also be updated
      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
      if (state._tag === "Active") {
        expect(state.value).toBe(42);
      }
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("returns ProcessEventResult for non-matching event", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-no-match", machine);

      // Idle state has no handler for Unknown event
      const result = yield* actor.call(TestEvent.Unknown);

      expect(result.transitioned).toBe(false);
      expect(result.previousState._tag).toBe("Idle");
      expect(result.newState._tag).toBe("Idle");
      expect(result.lifecycleRan).toBe(false);
      expect(result.isFinal).toBe(false);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("returns isFinal=true when reaching final state", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-final", machine);

      yield* actor.call(TestEvent.Start({ value: 1 }));
      const result = yield* actor.call(TestEvent.Stop);

      expect(result.transitioned).toBe(true);
      expect(result.newState._tag).toBe("Done");
      expect(result.isFinal).toBe(true);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("preserves serialization — events are processed in order", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-serial", machine);

      // Start, then update twice via call
      yield* actor.call(TestEvent.Start({ value: 1 }));

      const r1 = yield* actor.call(TestEvent.Update({ value: 10 }));
      expect(r1.newState._tag).toBe("Active");
      if (r1.newState._tag === "Active") {
        expect(r1.newState.value).toBe(10);
      }

      const r2 = yield* actor.call(TestEvent.Update({ value: 20 }));
      expect(r2.newState._tag).toBe("Active");
      if (r2.newState._tag === "Active") {
        expect(r2.newState.value).toBe(20);
      }
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("returns no-op result when actor is stopped", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-stopped", machine);

      yield* actor.call(TestEvent.Start({ value: 1 }));
      yield* actor.stop;

      const result = yield* actor.call(TestEvent.Update({ value: 99 }));

      expect(result.transitioned).toBe(false);
      expect(result.newState._tag).toBe("Active");
      expect(result.previousState._tag).toBe("Active");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("interleaves correctly with send", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("call-interleave", machine);

      // Use send to start, then call to update
      yield* actor.send(TestEvent.Start({ value: 1 }));
      yield* yieldFibers;

      const result = yield* actor.call(TestEvent.Update({ value: 55 }));
      expect(result.transitioned).toBe(true);
      if (result.newState._tag === "Active") {
        expect(result.newState.value).toBe(55);
      }
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("works with Machine.spawn (no system)", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      const result = yield* actor.call(TestEvent.Start({ value: 7 }));

      expect(result.transitioned).toBe(true);
      expect(result.newState._tag).toBe("Active");
      if (result.newState._tag === "Active") {
        expect(result.newState.value).toBe(7);
      }
    }),
  );
});

describe("ActorRef.call (Promise-free)", () => {
  it.scopedLive("call works with Machine.spawn (no system)", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      const result = yield* actor.call(TestEvent.Start({ value: 99 }));

      expect(result.transitioned).toBe(true);
      expect(result.previousState._tag).toBe("Idle");
      expect(result.newState._tag).toBe("Active");
      if (result.newState._tag === "Active") {
        expect(result.newState.value).toBe(99);
      }
    }),
  );

  it.scopedLive("non-matching event returns transitioned false", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      const result = yield* actor.call(TestEvent.Unknown);

      expect(result.transitioned).toBe(false);
      expect(result.newState._tag).toBe("Idle");
    }),
  );
});
