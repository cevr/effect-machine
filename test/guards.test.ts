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
  State,
  type AnyInspectionEvent,
} from "../src/index.js";

const TestState = State({
  Idle: { value: Schema.Finite },
  Low: {},
  High: {},
});

const TestEvent = Event({ Check: { minimum: Schema.Finite } });

describe("transition guards", () => {
  it.scopedLive("selects the first passing candidate and makes can guard-aware", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      })
        .on(TestState.Idle, TestEvent.Check, () => TestState.High, {
          guard: Machine.guard(
            "is-high",
            ({ state, event }) => state.value >= event.minimum + 50,
            ({ event }) => ({ minimum: event.minimum + 50 }),
          ),
        })
        .on(TestState.Idle, TestEvent.Check, () => TestState.Low, {
          guard: Machine.guard("is-low", ({ state, event }) => state.value >= event.minimum),
        });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("guarded", machine);

      expect(yield* actor.can(TestEvent.Check({ minimum: 40 }))).toBe(true);
      expect(actor.sync.can(TestEvent.Check({ minimum: 60 }))).toBe(false);

      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;
      expect((yield* actor.snapshot)._tag).toBe("Low");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("reports each evaluated guard with its parameters and result", () => {
    const events: AnyInspectionEvent[] = [];
    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      })
        .on(TestState.Idle, TestEvent.Check, () => TestState.High, {
          guard: Machine.guard(
            "is-high",
            ({ state, event }) => state.value >= event.minimum + 50,
            ({ event }) => ({ minimum: event.minimum + 50 }),
          ),
        })
        .on(TestState.Idle, TestEvent.Check, () => TestState.Low, {
          guard: Machine.guard("is-low", ({ state, event }) => state.value >= event.minimum),
        });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("inspected-guards", machine);
      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;

      expect(
        events
          .filter((event) => event.type === "@machine.guard")
          .map((event) => ({ guard: event.guard, params: event.params, result: event.result })),
      ).toEqual([
        { guard: "is-high", params: { minimum: 90 }, result: false },
        { guard: "is-low", params: undefined, result: true },
      ]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });
});
