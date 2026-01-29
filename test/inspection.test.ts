// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  collectingInspector,
  type InspectionEvent,
  makeInspector,
  InspectorService,
  Machine,
  State,
  Event,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const TestState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Done: { result: Schema.String },
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Fetch: { url: Schema.String },
  Success: { result: Schema.String },
  Reset: {},
});
type TestEvent = typeof TestEvent.Type;

describe("Inspection", () => {
  it.scopedLive("emits spawn event on actor creation", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      yield* system.spawn("test", machine);

      expect(events.length).toBeGreaterThanOrEqual(1);
      const spawnEvent = events.find((e) => e.type === "@machine.spawn");
      expect(spawnEvent).toBeDefined();
      expect(spawnEvent!.actorId).toBe("test");
      expect((spawnEvent as { initialState: TestState }).initialState._tag).toBe("Idle");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("emits event received on send", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const eventReceived = events.find((e) => e.type === "@machine.event");
      expect(eventReceived).toBeDefined();
      expect(eventReceived!.actorId).toBe("test");
      expect((eventReceived as { event: TestEvent }).event._tag).toBe("Fetch");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("emits transition event on state change", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const transitionEvent = events.find((e) => e.type === "@machine.transition");
      expect(transitionEvent).toBeDefined();
      expect((transitionEvent as { fromState: TestState }).fromState._tag).toBe("Idle");
      expect((transitionEvent as { toState: TestState }).toState._tag).toBe("Loading");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("emits spawn effect events", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }))
        .spawn(TestState.Idle, () => Effect.addFinalizer(() => Effect.void))
        .spawn(TestState.Loading, () => Effect.void);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const effectEvents = events.filter((e) => e.type === "@machine.effect");
      const spawnEvents = effectEvents.filter(
        (e) => (e as { effectType: string }).effectType === "spawn",
      );

      // Spawn for Idle (initial), spawn for Loading
      expect(spawnEvents.length).toBe(2);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("emits stop event on final state", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }))
        .on(TestState.Loading, TestEvent.Success, ({ event }) =>
          TestState.Done({ result: event.result }),
        )
        .final(TestState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;
      yield* actor.send(TestEvent.Success({ result: "ok" }));
      yield* yieldFibers;

      const stopEvent = events.find((e) => e.type === "@machine.stop");
      expect(stopEvent).toBeDefined();
      expect((stopEvent as { finalState: TestState }).finalState._tag).toBe("Done");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("emits stop event on manual stop", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.stop;

      const stopEvent = events.find((e) => e.type === "@machine.stop");
      expect(stopEvent).toBeDefined();
      expect(stopEvent!.actorId).toBe("test");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("no events emitted when no inspector provided", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Loading");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("inspector errors do not break event loop", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Loading");
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(
        InspectorService,
        makeInspector(() => {
          throw new Error("boom");
        }),
      ),
    ),
  );

  it.scopedLive("event order is correct", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }))
        .spawn(TestState.Idle, () => Effect.addFinalizer(() => Effect.void))
        .spawn(TestState.Loading, () => Effect.void);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      // Stop actor to trigger stop event
      yield* actor.stop;
      yield* yieldFibers;

      // Filter to events between spawn and stop (the transition events)
      const transitionEvents = events.slice(1, -1); // Remove spawn at start and stop at end

      // Expected order: spawn effect -> event received -> transition -> spawn effect
      const types = transitionEvents.map((e) => e.type);
      expect(types).toEqual([
        "@machine.effect", // spawn on Idle entry
        "@machine.event",
        "@machine.transition",
        "@machine.effect", // spawn on Loading entry
      ]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });
});
