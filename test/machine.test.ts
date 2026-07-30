// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, it, test } from "effect-bun-test";

import { Machine, simulate, State, Event, Slot } from "../src/index.js";
import { materializeMachine } from "../src/machine.js";

const CounterState = State({
  Idle: { count: Schema.Finite },
  Counting: { count: Schema.Finite },
  Done: { count: Schema.Finite },
});
type CounterState = typeof CounterState.Type;

const CounterEvent = Event({
  Start: {},
  Increment: {},
  Stop: {},
});

describe("Machine", () => {
  test("creates machine with initial state using .pipe() syntax", () => {
    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      initial: CounterState.Idle({ count: 0 }),
    }).on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
      CounterState.Counting({ count: state.count }),
    );
    expect(machine.initial._tag).toBe("Idle");
    expect(machine.initial.count).toBe(0);
  });

  it.scopedLive("defines transitions between states", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: CounterState,
        event: CounterEvent,
        initial: CounterState.Idle({ count: 0 }),
      })
        .on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
          CounterState.Counting({ count: state.count }),
        )
        .on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
          CounterState.Counting({ count: state.count + 1 }),
        )
        .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
          CounterState.Done({ count: state.count }),
        )
        .final(CounterState.Done);

      const result = yield* simulate(machine, [
        CounterEvent.Start,
        CounterEvent.Increment,
        CounterEvent.Increment,
        CounterEvent.Stop,
      ]);

      expect(result.finalState._tag).toBe("Done");
      expect(result.finalState.count).toBe(2);
    }),
  );

  it.scopedLive("supports slots via Slot.define", () =>
    Effect.gen(function* () {
      const CounterSlots = Slot.define({
        belowLimit: Slot.fn({ limit: Schema.Finite }, Schema.Boolean),
      });

      const machine = Machine.make({
        state: CounterState,
        event: CounterEvent,
        slots: CounterSlots,
        initial: CounterState.Counting({ count: 0 }),
      })
        .on(CounterState.Counting, CounterEvent.Increment, ({ state, slots }) =>
          Effect.gen(function* () {
            if (yield* slots.belowLimit({ limit: 3 })) {
              return CounterState.Counting({ count: state.count + 1 });
            }
            return state;
          }),
        )
        .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
          CounterState.Done({ count: state.count }),
        )
        .final(CounterState.Done);

      const result = yield* simulate(
        machine,
        [
          CounterEvent.Increment,
          CounterEvent.Increment,
          CounterEvent.Increment,
          CounterEvent.Increment, // blocked
          CounterEvent.Stop,
        ],
        {
          slots: {
            belowLimit: ({ limit }: { limit: number }) =>
              Effect.gen(function* () {
                const ctx = yield* machine.Context;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                return (ctx.state as any).count < limit;
              }),
          },
        },
      );

      expect(result.finalState.count).toBe(3);
    }),
  );

  it.scopedLive("supports effects in handler via Effect<State>", () =>
    Effect.gen(function* () {
      const logs: string[] = [];

      const machine = Machine.make({
        state: CounterState,
        event: CounterEvent,
        initial: CounterState.Idle({ count: 0 }),
      })
        .on(CounterState.Idle, CounterEvent.Start, ({ state }) =>
          Effect.gen(function* () {
            yield* Effect.sync(() => logs.push(`Starting from count ${state.count}`));
            return CounterState.Counting({ count: state.count });
          }),
        )
        .on(CounterState.Counting, CounterEvent.Stop, ({ state }) =>
          CounterState.Done({ count: state.count }),
        )
        .final(CounterState.Done);

      yield* simulate(machine, [CounterEvent.Start, CounterEvent.Stop]);
      expect(logs).toEqual(["Starting from count 0"]);
    }),
  );

  test("marks states as final", () => {
    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      initial: CounterState.Idle({ count: 0 }),
    })
      .on(CounterState.Idle, CounterEvent.Start, () => CounterState.Done({ count: 0 }))
      .final(CounterState.Done);
    expect(machine.finalStates.has("Done")).toBe(true);
    expect(machine.finalStates.has("Idle")).toBe(false);
  });
});

// ============================================================================
// Multi-state .on() / .reenter() (F1)
// ============================================================================

describe("multi-state .on()", () => {
  const WState = State({
    Draft: {},
    Review: {},
    Approved: {},
    Cancelled: {},
  });
  const WEvent = Event({
    Submit: {},
    Approve: {},
    Cancel: {},
  });

  it.scopedLive("array of states registers transition for each", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WState,
        event: WEvent,
        initial: WState.Draft,
      })
        .on([WState.Draft, WState.Review], WEvent.Cancel, () => WState.Cancelled)
        .on(WState.Draft, WEvent.Submit, () => WState.Review)
        .on(WState.Review, WEvent.Approve, () => WState.Approved)
        .final(WState.Cancelled)
        .final(WState.Approved);

      // Cancel from Draft
      const r1 = yield* simulate(machine, [WEvent.Cancel]);
      expect(r1.finalState._tag).toBe("Cancelled");

      // Cancel from Review
      const r2 = yield* simulate(machine, [WEvent.Submit, WEvent.Cancel]);
      expect(r2.finalState._tag).toBe("Cancelled");
    }),
  );

  it.scopedLive("single state still works (backward compat)", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WState,
        event: WEvent,
        initial: WState.Draft,
      })
        .on(WState.Draft, WEvent.Submit, () => WState.Review)
        .on(WState.Review, WEvent.Approve, () => WState.Approved)
        .final(WState.Approved);

      const r = yield* simulate(machine, [WEvent.Submit, WEvent.Approve]);
      expect(r.finalState._tag).toBe("Approved");
    }),
  );

  test("empty array is a no-op", () => {
    const machine = Machine.make({
      state: WState,
      event: WEvent,
      initial: WState.Draft,
    }).on([] as (typeof WState.Draft)[], WEvent.Cancel, () => WState.Cancelled);

    expect(machine.transitions.length).toBe(0);
  });
});

describe("multi-state .reenter()", () => {
  test("reenter with array registers for each state", () => {
    const RState = State({
      A: { value: Schema.Finite },
      B: { value: Schema.Finite },
    });
    const REvent = Event({ Reset: {} });

    const machine = Machine.make({
      state: RState,
      event: REvent,
      initial: RState.A({ value: 0 }),
    }).reenter([RState.A, RState.B], REvent.Reset, ({ state }) =>
      RState.A({ value: state.value + 1 }),
    );

    expect(machine.transitions.length).toBe(2);
    expect(machine.transitions[0]!.reenter).toBe(true);
    expect(machine.transitions[1]!.reenter).toBe(true);
  });
});

// ============================================================================
// .onAny() wildcard transitions (F5)
// ============================================================================

describe(".onAny()", () => {
  const AState = State({
    Idle: {},
    Loading: {},
    Active: {},
    Cancelled: {},
  });
  const AEvent = Event({
    Start: {},
    Load: {},
    Cancel: {},
  });

  it.scopedLive("wildcard catches event from any state", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: AState,
        event: AEvent,
        initial: AState.Idle,
      })
        .on(AState.Idle, AEvent.Start, () => AState.Loading)
        .on(AState.Loading, AEvent.Load, () => AState.Active)
        .onAny(AEvent.Cancel, () => AState.Cancelled)
        .final(AState.Cancelled);

      // Cancel from Idle
      const r1 = yield* simulate(machine, [AEvent.Cancel]);
      expect(r1.finalState._tag).toBe("Cancelled");

      // Cancel from Loading
      const r2 = yield* simulate(machine, [AEvent.Start, AEvent.Cancel]);
      expect(r2.finalState._tag).toBe("Cancelled");

      // Cancel from Active
      const r3 = yield* simulate(machine, [AEvent.Start, AEvent.Load, AEvent.Cancel]);
      expect(r3.finalState._tag).toBe("Cancelled");
    }),
  );

  it.scopedLive("specific .on() takes priority over .onAny()", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: AState,
        event: AEvent,
        initial: AState.Idle,
      })
        .on(AState.Idle, AEvent.Cancel, () => AState.Active) // specific
        .onAny(AEvent.Cancel, () => AState.Cancelled)
        .final(AState.Active)
        .final(AState.Cancelled);

      // Idle + Cancel -> uses specific (Active), not wildcard (Cancelled)
      const r = yield* simulate(machine, [AEvent.Cancel]);
      expect(r.finalState._tag).toBe("Active");
    }),
  );

  it.scopedLive("multiple .onAny() for different events", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: AState,
        event: AEvent,
        initial: AState.Idle,
      })
        .onAny(AEvent.Cancel, () => AState.Cancelled)
        .onAny(AEvent.Start, () => AState.Loading)
        .final(AState.Cancelled);

      const r1 = yield* simulate(machine, [AEvent.Cancel]);
      expect(r1.finalState._tag).toBe("Cancelled");

      const r2 = yield* simulate(machine, [AEvent.Start]);
      expect(r2.finalState._tag).toBe("Loading");
    }),
  );
});

describe(".from()", () => {
  it.scopedLive("scopes repeated transitions to shared states", () =>
    Effect.gen(function* () {
      const FlowState = State({
        Draft: {},
        Review: {},
        Approved: {},
        Cancelled: {},
      });
      const FlowEvent = Event({
        Submit: {},
        Approve: {},
        Cancel: {},
      });

      const machine = Machine.make({
        state: FlowState,
        event: FlowEvent,
        initial: FlowState.Draft,
      })
        .on(FlowState.Draft, FlowEvent.Submit, () => FlowState.Review)
        .from([FlowState.Draft, FlowState.Review], (scope) =>
          scope.on(FlowEvent.Cancel, () => FlowState.Cancelled),
        )
        .from(FlowState.Review, (scope) => scope.on(FlowEvent.Approve, () => FlowState.Approved))
        .final(FlowState.Cancelled)
        .final(FlowState.Approved);

      const cancelled = yield* simulate(machine, [FlowEvent.Cancel]);
      expect(cancelled.finalState._tag).toBe("Cancelled");

      const approved = yield* simulate(machine, [FlowEvent.Submit, FlowEvent.Approve]);
      expect(approved.finalState._tag).toBe("Approved");
    }),
  );
});

// ============================================================================
//  (F7)
// ============================================================================

describe("materializeMachine", () => {
  test("throws ProvisionValidationError when slots missing", () => {
    const TestSlots = Slot.define({
      check: Slot.fn({}, Schema.Boolean),
      notify: Slot.fn({}),
    });

    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      slots: TestSlots,
      initial: CounterState.Idle({ count: 0 }),
    });

    expect(() => materializeMachine(machine, {})).toThrow();
  });

  test("succeeds when all handlers provided", () => {
    const TestSlots = Slot.define({
      check: Slot.fn({}, Schema.Boolean),
    });

    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      slots: TestSlots,
      initial: CounterState.Idle({ count: 0 }),
    });

    const materialized = materializeMachine(machine, {
      check: () => true,
    });

    expect(materialized.initial._tag).toBe("Idle");
  });

  test("no-arg materialize works on slotless machine", () => {
    const machine = Machine.make({
      state: CounterState,
      event: CounterEvent,
      initial: CounterState.Idle({ count: 0 }),
    });

    const materialized = materializeMachine(machine);
    expect(materialized.initial._tag).toBe("Idle");
  });
});
