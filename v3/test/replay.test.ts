// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, Stream } from "effect";

import { Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test/v3";

// ============================================================================
// Test Fixtures
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
  Increment: {},
  Finish: {},
});
type TestEvent = typeof TestEvent.Type;

const createMachine = () =>
  Machine.make({
    state: TestState,
    event: TestEvent,
    initial: TestState.Idle,
  })
    .on(TestState.Idle, TestEvent.Start, ({ event }) => TestState.Loading({ value: event.value }))
    .on(TestState.Loading, TestEvent.Complete, ({ state }) =>
      TestState.Active({ value: state.value }),
    )
    .on(TestState.Active, TestEvent.Increment, ({ state }) =>
      TestState.Active({ value: state.value + 1 }),
    )
    .on(TestState.Active, TestEvent.Finish, () => TestState.Done)
    .final(TestState.Done);

// ============================================================================
// Machine.replay
// ============================================================================

describe("Machine.replay", () => {
  it.live("replays events from initial state", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const state = yield* Machine.replay(machine, [
        TestEvent.Start({ value: 10 }),
        TestEvent.Complete,
        TestEvent.Increment,
        TestEvent.Increment,
      ]);

      expect(state._tag).toBe("Active");
      expect((state as { value: number }).value).toBe(12);
    }),
  );

  it.live("replays from a snapshot midpoint", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const state = yield* Machine.replay(
        machine,
        [TestEvent.Increment, TestEvent.Increment, TestEvent.Increment],
        { from: TestState.Active({ value: 100 }) },
      );

      expect(state._tag).toBe("Active");
      expect((state as { value: number }).value).toBe(103);
    }),
  );

  it.live("returns initial state for empty events", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const state = yield* Machine.replay(machine, []);
      expect(state._tag).toBe("Idle");
    }),
  );

  it.live("skips unhandled events", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const state = yield* Machine.replay(machine, [
        TestEvent.Complete, // unhandled in Idle
        TestEvent.Start({ value: 5 }),
        TestEvent.Finish, // unhandled in Loading
        TestEvent.Complete,
      ]);

      expect(state._tag).toBe("Active");
      expect((state as { value: number }).value).toBe(5);
    }),
  );

  it.live("stops at final state", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const state = yield* Machine.replay(machine, [
        TestEvent.Start({ value: 1 }),
        TestEvent.Complete,
        TestEvent.Finish, // → Done (final)
        TestEvent.Start({ value: 99 }), // should be ignored
      ]);

      expect(state._tag).toBe("Done");
    }),
  );

  it.live("handles effectful transition handlers", () =>
    Effect.gen(function* () {
      const EffState = State({
        Initial: {},
        Computed: { result: Schema.Number },
      });
      const EffEvent = Event({
        Compute: { input: Schema.Number },
      });

      const machine = Machine.make({
        state: EffState,
        event: EffEvent,
        initial: EffState.Initial,
      }).on(EffState.Initial, EffEvent.Compute, ({ event }) =>
        Effect.succeed(EffState.Computed({ result: event.input * 2 })),
      );

      const state = yield* Machine.replay(machine, [EffEvent.Compute({ input: 21 })]);
      expect(state._tag).toBe("Computed");
      expect((state as { result: number }).result).toBe(42);
    }),
  );
});

// ============================================================================
// Machine.replay — postpone semantics
// ============================================================================

describe("Machine.replay postpone", () => {
  it.live("buffers postponed events and drains on state change", () =>
    Effect.gen(function* () {
      const PState = State({
        Waiting: {},
        Ready: { count: Schema.Number },
        Done: {},
      });
      const PEvent = Event({
        Process: {},
        Activate: {},
      });

      const machine = Machine.make({
        state: PState,
        event: PEvent,
        initial: PState.Waiting,
      })
        .on(PState.Waiting, PEvent.Activate, () => PState.Ready({ count: 0 }))
        .on(PState.Ready, PEvent.Process, ({ state }) => PState.Ready({ count: state.count + 1 }))
        .postpone(PState.Waiting, PEvent.Process);

      // Process is postponed in Waiting, then drained after Activate → Ready
      const state = yield* Machine.replay(machine, [
        PEvent.Process,
        PEvent.Process,
        PEvent.Activate,
      ]);

      expect(state._tag).toBe("Ready");
      expect((state as { count: number }).count).toBe(2);
    }),
  );

  it.live("multi-stage postpone drains until stable", () =>
    Effect.gen(function* () {
      const MSState = State({
        A: {},
        B: {},
        C: {},
        Done: {},
      });
      const MSEvent = Event({
        GoB: {},
        GoC: {},
        Finish: {},
      });

      const machine = Machine.make({
        state: MSState,
        event: MSEvent,
        initial: MSState.A,
      })
        .on(MSState.A, MSEvent.GoB, () => MSState.B)
        .on(MSState.B, MSEvent.GoC, () => MSState.C)
        .on(MSState.C, MSEvent.Finish, () => MSState.Done)
        // Finish is postponed in A and B — only runnable in C
        .postpone(MSState.A, MSEvent.Finish)
        .postpone(MSState.B, MSEvent.Finish)
        // GoC is postponed in A — only runnable in B
        .postpone(MSState.A, MSEvent.GoC)
        .final(MSState.Done);

      // Finish postponed in A, GoC postponed in A.
      // GoB moves to B → drains GoC (moves to C) → drains Finish (moves to Done)
      const state = yield* Machine.replay(machine, [MSEvent.Finish, MSEvent.GoC, MSEvent.GoB]);

      expect(state._tag).toBe("Done");
    }),
  );
});

// ============================================================================
// actor.transitions stream
// ============================================================================

describe("actor.transitions", () => {
  it.live("emits on successful transitions", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      const collected: Array<{ from: string; to: string; event: string }> = [];
      yield* Effect.forkDaemon(
        actor.transitions.pipe(
          Stream.runForEach((t) =>
            Effect.sync(() => {
              collected.push({
                from: t.fromState._tag,
                to: t.toState._tag,
                event: t.event._tag,
              });
            }),
          ),
        ),
      );
      yield* yieldFibers; // let subscriber attach

      yield* actor.call(TestEvent.Start({ value: 1 }));
      yield* actor.call(TestEvent.Complete);
      yield* actor.call(TestEvent.Increment);
      yield* yieldFibers;

      expect(collected.length).toBe(3);
      expect(collected[0]).toEqual({ from: "Idle", to: "Loading", event: "Start" });
      expect(collected[1]).toEqual({ from: "Loading", to: "Active", event: "Complete" });
      expect(collected[2]).toEqual({ from: "Active", to: "Active", event: "Increment" });

      yield* actor.stop;
    }),
  );

  it.live("does not emit for unhandled events", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);

      const collected: string[] = [];
      yield* Effect.forkDaemon(
        actor.transitions.pipe(
          Stream.runForEach((t) =>
            Effect.sync(() => {
              collected.push(t.event._tag);
            }),
          ),
        ),
      );
      yield* yieldFibers; // let subscriber attach

      yield* actor.call(TestEvent.Complete); // unhandled in Idle
      yield* actor.call(TestEvent.Start({ value: 1 })); // handled
      yield* yieldFibers;

      expect(collected).toEqual(["Start"]);

      yield* actor.stop;
    }),
  );
});
