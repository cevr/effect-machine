import { Effect, Schema } from "effect";

import { Machine, State, Event, Slot, simulate, createTestHarness } from "../src/index.js";
import { materializeMachine } from "../src/machine.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test/v3";
import { test } from "bun:test";

// ============================================================================
// Test Fixtures
// ============================================================================

const SimpleState = State({
  Idle: {},
  Active: { count: Schema.Number },
  Done: {},
});
type SimpleState = typeof SimpleState.Type;

const SimpleEvent = Event({
  Start: { count: Schema.Number },
  Increment: {},
  Finish: {},
});
type SimpleEvent = typeof SimpleEvent.Type;

const SlotGuards = Slot.Guards({
  canStart: {},
});

const SlotEffects = Slot.Effects({
  onStart: {},
});

const createSimpleMachine = () =>
  Machine.make({
    state: SimpleState,
    event: SimpleEvent,
    initial: SimpleState.Idle,
  })
    .on(SimpleState.Idle, SimpleEvent.Start, ({ event }) =>
      SimpleState.Active({ count: event.count }),
    )
    .on(SimpleState.Active, SimpleEvent.Increment, ({ state }) =>
      SimpleState.Active({ count: state.count + 1 }),
    )
    .on(SimpleState.Active, SimpleEvent.Finish, () => SimpleState.Done)
    .final(SimpleState.Done);

const createSlotMachine = () =>
  Machine.make({
    state: SimpleState,
    event: SimpleEvent,
    guards: SlotGuards,
    effects: SlotEffects,
    initial: SimpleState.Idle,
  })
    .on(SimpleState.Idle, SimpleEvent.Start, ({ event, guards, effects }) =>
      Effect.gen(function* () {
        if (yield* guards.canStart()) {
          yield* effects.onStart();
          return SimpleState.Active({ count: event.count });
        }
        return SimpleState.Idle;
      }),
    )
    .on(SimpleState.Active, SimpleEvent.Finish, () => SimpleState.Done)
    .final(SimpleState.Done);

// ============================================================================
// Machine.spawn with slots (spawn-time materialization)
// ============================================================================

describe("Machine.spawn with slots", () => {
  it.scopedLive("spawns with slots at spawn time", () =>
    Effect.gen(function* () {
      const machine = createSlotMachine();
      const actor = yield* Machine.spawn(machine, {
        slots: {
          canStart: () => true,
          onStart: () => Effect.void,
        },
      });

      yield* actor.send(SimpleEvent.Start({ count: 42 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
    }),
  );

  it.scopedLive("no-slot machine spawns without slots option", () =>
    Effect.gen(function* () {
      const machine = createSimpleMachine();
      const actor = yield* Machine.spawn(machine);

      yield* actor.send(SimpleEvent.Start({ count: 1 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
    }),
  );

  it.scopedLive("spawn with slots works end-to-end", () =>
    Effect.gen(function* () {
      const machine = createSlotMachine();
      const actor = yield* Machine.spawn(machine, {
        slots: {
          canStart: () => true,
          onStart: () => Effect.void,
        },
      });

      yield* actor.send(SimpleEvent.Start({ count: 5 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
    }),
  );
});

// ============================================================================
// materializeMachine validation
// ============================================================================

describe("materializeMachine", () => {
  test("throws ProvisionValidationError for slotful machine without handlers", () => {
    const machine = createSlotMachine();
    expect(() => materializeMachine(machine)).toThrow();
  });

  test("throws ProvisionValidationError for missing slot handlers", () => {
    const machine = createSlotMachine();
    expect(() => materializeMachine(machine, { canStart: () => true })).toThrow();
  });

  test("throws ProvisionValidationError for extra slot handlers", () => {
    const machine = createSlotMachine();
    expect(() =>
      materializeMachine(machine, {
        canStart: () => true,
        onStart: () => Effect.void,
        extra: () => true,
      }),
    ).toThrow();
  });

  test("returns machine as-is for no-slot machine", () => {
    const machine = createSimpleMachine();
    const result = materializeMachine(machine);
    expect(result).toBe(machine);
  });

  test("returns fresh copy for slotful machine with handlers", () => {
    const machine = createSlotMachine();
    const result = materializeMachine(machine, {
      canStart: () => true,
      onStart: () => Effect.void,
    });
    expect(result).not.toBe(machine);
    expect(result.initial).toEqual(machine.initial);
  });
});

// ============================================================================
// Machine.replay with slots
// ============================================================================

describe("Machine.replay with slots", () => {
  it.scopedLive("replays with slots at replay time", () =>
    Effect.gen(function* () {
      const machine = createSlotMachine();
      const state = yield* Machine.replay(machine, [SimpleEvent.Start({ count: 10 })], {
        slots: {
          canStart: () => true,
          onStart: () => Effect.void,
        },
      });

      expect(state._tag).toBe("Active");
      if (state._tag === "Active") {
        expect(state.count).toBe(10);
      }
    }),
  );
});

// ============================================================================
// simulate with slots
// ============================================================================

describe("simulate with slots", () => {
  it.scopedLive("simulates with slots option", () =>
    Effect.gen(function* () {
      const machine = createSlotMachine();
      const result = yield* simulate(machine, [SimpleEvent.Start({ count: 7 })], {
        slots: {
          canStart: () => true,
          onStart: () => Effect.void,
        },
      });

      expect(result.finalState._tag).toBe("Active");
    }),
  );
});

// ============================================================================
// createTestHarness with slots
// ============================================================================

describe("createTestHarness with slots", () => {
  it.scopedLive("harness with slots option", () =>
    Effect.gen(function* () {
      const machine = createSlotMachine();
      const harness = yield* createTestHarness(machine, {
        slots: {
          canStart: () => true,
          onStart: () => Effect.void,
        },
      });

      yield* harness.send(SimpleEvent.Start({ count: 3 }));
      const state = yield* harness.getState;
      expect(state._tag).toBe("Active");
    }),
  );
});
