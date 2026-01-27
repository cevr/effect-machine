// @effect-diagnostics strictEffectProvide:off - tests are entry points
/**
 * Transition Index Tests
 *
 * Verifies O(1) lookup performance and correctness of the
 * transition index used for state/event matching.
 */
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { Event, Machine, State } from "../src/index.js";

// Test state machine types
const TestState = State({
  Idle: {},
  Loading: { id: Schema.String },
  Success: { data: Schema.String },
  Error: { message: Schema.String },
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Start: { id: Schema.String },
  Succeed: { data: Schema.String },
  Fail: { message: Schema.String },
  Reset: {},
});
type TestEvent = typeof TestEvent.Type;

describe("Transition Index", () => {
  test("Machine.findTransitions returns matching transitions", () => {
    const machine = Machine.make<TestState, TestEvent>(TestState.Idle({})).pipe(
      Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Loading({ id: event.id }),
      ),
      Machine.on(TestState.Loading, TestEvent.Succeed, ({ event }) =>
        TestState.Success({ data: event.data }),
      ),
      Machine.on(TestState.Loading, TestEvent.Fail, ({ event }) =>
        TestState.Error({ message: event.message }),
      ),
    );

    // Find transitions for Idle + Start
    const idleStartTransitions = Machine.findTransitions(machine, "Idle", "Start");
    expect(idleStartTransitions.length).toBe(1);
    expect(idleStartTransitions[0]?.stateTag).toBe("Idle");
    expect(idleStartTransitions[0]?.eventTag).toBe("Start");

    // Find transitions for Loading + Succeed
    const loadingSucceedTransitions = Machine.findTransitions(machine, "Loading", "Succeed");
    expect(loadingSucceedTransitions.length).toBe(1);

    // Find transitions for Loading + Fail
    const loadingFailTransitions = Machine.findTransitions(machine, "Loading", "Fail");
    expect(loadingFailTransitions.length).toBe(1);

    // No transitions for Idle + Fail
    const noTransitions = Machine.findTransitions(machine, "Idle", "Fail");
    expect(noTransitions.length).toBe(0);
  });

  test("findTransitions returns multiple transitions for guard cascade", () => {
    const machine = Machine.make<TestState, TestEvent>(TestState.Idle({})).pipe(
      // Multiple transitions with guards for same state/event
      Machine.on(
        TestState.Idle,
        TestEvent.Start,
        ({ event }) => TestState.Loading({ id: event.id }),
        { guard: ({ event }) => event.id === "special" },
      ),
      Machine.on(
        TestState.Idle,
        TestEvent.Start,
        ({ event }) => TestState.Loading({ id: event.id }),
        { guard: ({ event }) => event.id === "normal" },
      ),
      Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Loading({ id: event.id }),
      ), // fallback
    );

    const transitions = Machine.findTransitions(machine, "Idle", "Start");
    expect(transitions.length).toBe(3);

    // Should preserve registration order
    expect(transitions[0]?.guard).toBeDefined();
    expect(transitions[1]?.guard).toBeDefined();
    expect(transitions[2]?.guard).toBeUndefined();
  });

  test("findAlwaysTransitions returns always transitions for state", () => {
    const CounterState = State({
      Counting: { count: Schema.Number },
      Done: { count: Schema.Number },
    });
    type CounterState = typeof CounterState.Type;

    const CounterEvent = Event({ Increment: {} });
    type CounterEvent = typeof CounterEvent.Type;

    const machine = Machine.make<CounterState, CounterEvent>(
      CounterState.Counting({ count: 0 }),
    ).pipe(
      Machine.on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
        CounterState.Counting({ count: state.count + 1 }),
      ),
      Machine.always(CounterState.Counting, [
        {
          guard: (state) => state.count >= 10,
          to: (state) => CounterState.Done({ count: state.count }),
        },
      ]),
    );

    const alwaysTransitions = Machine.findAlwaysTransitions(machine, "Counting");
    expect(alwaysTransitions.length).toBe(1);
    expect(alwaysTransitions[0]?.stateTag).toBe("Counting");

    const noAlways = Machine.findAlwaysTransitions(machine, "Done");
    expect(noAlways.length).toBe(0);
  });

  test("index is cached (WeakMap behavior)", () => {
    const machine = Machine.make<TestState, TestEvent>(TestState.Idle({})).pipe(
      Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Loading({ id: event.id }),
      ),
    );

    // Call multiple times - should use cached index
    const t1 = Machine.findTransitions(machine, "Idle", "Start");
    const t2 = Machine.findTransitions(machine, "Idle", "Start");
    const t3 = Machine.findTransitions(machine, "Loading", "Succeed");

    // Should return same array reference from cache
    expect(t1).toBe(t2);
    expect(t3.length).toBe(0);
  });

  test("different machines have separate indexes", () => {
    const machine1 = Machine.make<TestState, TestEvent>(TestState.Idle({})).pipe(
      Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Loading({ id: event.id }),
      ),
    );

    const machine2 = Machine.make<TestState, TestEvent>(TestState.Idle({})).pipe(
      Machine.on(TestState.Idle, TestEvent.Start, ({ event }) =>
        TestState.Loading({ id: event.id }),
      ),
      Machine.on(TestState.Idle, TestEvent.Reset, () => TestState.Idle({})),
    );

    const m1Transitions = Machine.findTransitions(machine1, "Idle", "Start");
    const m2Transitions = Machine.findTransitions(machine2, "Idle", "Start");

    expect(m1Transitions.length).toBe(1);
    expect(m2Transitions.length).toBe(1);
    // Different machines - different objects
    expect(m1Transitions).not.toBe(m2Transitions);
  });
});
