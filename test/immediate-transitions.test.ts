// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  ActorSystemDefault,
  ActorSystemService,
  collectingInspector,
  Event,
  InspectorService,
  Machine,
  createTestHarness,
  simulate,
  State,
  type AnyInspectionEvent,
} from "../src/index.js";

const TestState = State({
  Idle: {},
  Checking: { value: Schema.Finite },
  Accepted: {},
  Rejected: {},
});
const TestEvent = Event({ Check: { value: Schema.Finite } });

describe("immediate transitions", () => {
  it.scopedLive("settles initial state in simulation, replay, and the test harness", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Checking({ value: 20 }),
      }).immediate(TestState.Checking, () => TestState.Accepted);

      expect((yield* simulate(machine, [])).finalState._tag).toBe("Accepted");
      expect((yield* Machine.replay(machine, []))._tag).toBe("Accepted");
      const harness = yield* createTestHarness(machine);
      expect((yield* harness.getState)._tag).toBe("Accepted");
    }),
  );

  it.scopedLive("settles the initial state before state-scoped work starts", () => {
    const spawned: string[] = [];
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Checking({ value: 20 }),
    })
      .immediate(TestState.Checking, () => TestState.Accepted)
      .spawn(TestState.Checking, () => Effect.sync(() => void spawned.push("Checking")))
      .spawn(TestState.Accepted, () => Effect.sync(() => void spawned.push("Accepted")));

    return Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* Effect.yieldNow;

      expect((yield* actor.snapshot)._tag).toBe("Accepted");
      expect(spawned).toEqual(["Accepted"]);
      expect(actor.sync.latestTransition()?.fromState._tag).toBe("Checking");
      expect(actor.sync.latestTransition()?.toState._tag).toBe("Accepted");
    }).pipe(Effect.provide(ActorSystemDefault));
  });

  it.scopedLive("settles guarded eventless transitions before UI observers see state", () => {
    const observed: string[] = [];
    const inspected: AnyInspectionEvent[] = [];
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Idle,
    })
      .on(TestState.Idle, TestEvent.Check, ({ event }) =>
        TestState.Checking({ value: event.value }),
      )
      .immediate(TestState.Checking, () => TestState.Accepted, {
        guard: Machine.guard("accept", ({ state }) => state.value >= 10),
      })
      .immediate(TestState.Checking, () => TestState.Rejected);

    return Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("immediate", machine);
      actor.subscribe((state) => observed.push(state._tag));
      yield* actor.send(TestEvent.Check({ value: 12 }));
      yield* Effect.yieldNow;

      expect((yield* actor.snapshot)._tag).toBe("Accepted");
      expect(observed).toEqual(["Accepted"]);
      expect(
        inspected
          .filter((event) => event.type === "@machine.transition")
          .map((event) => `${event.fromState._tag}->${event.toState._tag}`),
      ).toEqual(["Idle->Checking", "Checking->Accepted"]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(inspected)),
    );
  });

  it.scopedLive("defects instead of spinning forever in an eventless loop", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Check, ({ event }) =>
          TestState.Checking({ value: event.value }),
        )
        .immediate(TestState.Checking, ({ state }) => TestState.Checking.with(state));

      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* actor.send(TestEvent.Check({ value: 1 }));
      const exit = yield* actor.awaitExit;
      expect(exit._tag).toBe("Defect");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
