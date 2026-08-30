// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Context, Effect, Schema } from "effect";
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

class Threshold extends Context.Service<Threshold, number>()(
  "effect-machine/test/guards.test/Threshold",
) {}

describe("transition guards", () => {
  it.scopedLive("selects the first passing candidate and makes can guard-aware", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      })
        .when(
          TestState.Idle,
          TestEvent.Check,
          ({ state, event }) => state.value >= event.minimum + 50,
          () => TestState.High,
        )
        .when(
          TestState.Idle,
          TestEvent.Check,
          ({ state, event }) => state.value >= event.minimum,
          () => TestState.Low,
        );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("guarded", machine);

      expect(yield* actor.can(TestEvent.Check({ minimum: 40 }))).toBe(true);
      expect(actor.client.canSync(TestEvent.Check({ minimum: 60 }))).toBe(false);

      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;
      expect((yield* actor.snapshot)._tag).toBe("Low");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("reports each evaluated guard with its result", () => {
    const events: AnyInspectionEvent[] = [];
    return Effect.gen(function* () {
      const isHigh = ({
        state,
        event,
      }: {
        readonly state: { readonly _tag: "Idle"; readonly value: number };
        readonly event: { readonly _tag: "Check"; readonly minimum: number };
      }) => state.value >= event.minimum + 50;
      const isLow = ({
        state,
        event,
      }: {
        readonly state: { readonly _tag: "Idle"; readonly value: number };
        readonly event: { readonly _tag: "Check"; readonly minimum: number };
      }) => state.value >= event.minimum;

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      })
        .when(TestState.Idle, TestEvent.Check, isHigh, () => TestState.High)
        .when(TestState.Idle, TestEvent.Check, isLow, () => TestState.Low);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("inspected-guards", machine);
      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;

      expect(
        events
          .filter((event) => event.type === "@machine.guard")
          .map((event) => ({ guard: event.guard, result: event.result })),
      ).toEqual([
        { guard: "isHigh", result: false },
        { guard: "isLow", result: true },
      ]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("reports an inline guard without registration", () => {
    const events: AnyInspectionEvent[] = [];
    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      }).when(
        TestState.Idle,
        TestEvent.Check,
        ({ state, event }) => state.value >= event.minimum,
        () => TestState.Low,
      );

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("inline-guard", machine);
      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;

      expect(
        events
          .filter((event) => event.type === "@machine.guard")
          .map((event) => ({ guard: event.guard, result: event.result })),
      ).toEqual([{ guard: "<inline>", result: true }]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("uses captured Effect services in can and transition guards", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle({ value: 50 }),
      }).when(
        TestState.Idle,
        TestEvent.Check,
        ({ event }) => Threshold.pipe(Effect.map((threshold) => event.minimum <= threshold)),
        () => TestState.High,
      );

      const actor = yield* Machine.spawn(machine).pipe(Effect.provideService(Threshold, 40));
      yield* actor.start;

      expect(yield* actor.can(TestEvent.Check({ minimum: 40 }))).toBe(true);
      expect(yield* actor.can(TestEvent.Check({ minimum: 41 }))).toBe(false);
      expect(() => actor.client.canSync(TestEvent.Check({ minimum: 40 }))).toThrow(
        "Effect guards require actor.can(event)",
      );
      expect(yield* Effect.promise(() => actor.client.can(TestEvent.Check({ minimum: 40 })))).toBe(
        true,
      );

      yield* actor.send(TestEvent.Check({ minimum: 40 }));
      yield* Effect.yieldNow;
      expect((yield* actor.snapshot)._tag).toBe("High");
    }),
  );
});
