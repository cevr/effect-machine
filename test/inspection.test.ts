// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  collectingInspector,
  Guard,
  type InspectionEvent,
  InspectorService,
  Machine,
  yieldFibers,
  State,
  Event,
} from "../src/index.js";

type TestState = State<{
  Idle: {};
  Loading: { url: string };
  Done: { result: string };
}>;
const TestState = State<TestState>();

type TestEvent = Event<{
  Fetch: { url: string };
  Success: { result: string };
  Reset: {};
}>;
const TestEvent = Event<TestEvent>();

describe("Inspection", () => {
  test("emits spawn event on actor creation", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        yield* system.spawn("test", machine);
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    expect(events.length).toBeGreaterThanOrEqual(1);
    const spawnEvent = events.find((e) => e.type === "@machine.spawn");
    expect(spawnEvent).toBeDefined();
    expect(spawnEvent!.actorId).toBe("test");
    expect((spawnEvent as { initialState: TestState }).initialState._tag).toBe("Idle");
  });

  test("emits event received on send", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const eventReceived = events.find((e) => e.type === "@machine.event");
    expect(eventReceived).toBeDefined();
    expect(eventReceived!.actorId).toBe("test");
    expect((eventReceived as { event: TestEvent }).event._tag).toBe("Fetch");
  });

  test("emits transition event on state change", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const transitionEvent = events.find((e) => e.type === "@machine.transition");
    expect(transitionEvent).toBeDefined();
    expect((transitionEvent as { fromState: TestState }).fromState._tag).toBe("Idle");
    expect((transitionEvent as { toState: TestState }).toState._tag).toBe("Loading");
  });

  test("emits guard evaluation events", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    const canFetch = Guard.make<TestState, TestEvent>(() => true, "canFetch");

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(
              TestState.Idle,
              TestEvent.Fetch,
              ({ event }) => TestState.Loading({ url: event.url }),
              {
                guard: canFetch,
              },
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const guardEvent = events.find((e) => e.type === "@machine.guard");
    expect(guardEvent).toBeDefined();
    expect((guardEvent as { guardName: string }).guardName).toBe("canFetch");
    expect((guardEvent as { result: boolean }).result).toBe(true);
  });

  test("emits entry and exit effect events", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
            Machine.onEnter(TestState.Idle, () => Effect.void),
            Machine.onExit(TestState.Idle, () => Effect.void),
            Machine.onEnter(TestState.Loading, () => Effect.void),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const effectEvents = events.filter((e) => e.type === "@machine.effect");
    const entryEvents = effectEvents.filter(
      (e) => (e as { effectType: string }).effectType === "entry",
    );
    const exitEvents = effectEvents.filter(
      (e) => (e as { effectType: string }).effectType === "exit",
    );

    // Entry for Idle (initial), exit for Idle, entry for Loading
    expect(entryEvents.length).toBe(2);
    expect(exitEvents.length).toBe(1);
  });

  test("emits stop event on final state", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
            Machine.on(TestState.Loading, TestEvent.Success, ({ event }) =>
              TestState.Done({ result: event.result }),
            ),
            Machine.final(TestState.Done),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
        yield* actor.send(TestEvent.Success({ result: "ok" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const stopEvent = events.find((e) => e.type === "@machine.stop");
    expect(stopEvent).toBeDefined();
    expect((stopEvent as { finalState: TestState }).finalState._tag).toBe("Done");
  });

  test("emits stop event on manual stop", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.stop;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const stopEvent = events.find((e) => e.type === "@machine.stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent!.actorId).toBe("test");
  });

  test("no events emitted when no inspector provided", async () => {
    // This test verifies the inspector is optional
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(TestState.Idle, TestEvent.Fetch, ({ event }) =>
              TestState.Loading({ url: event.url }),
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Loading");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("guard naming with Guard.named", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    const baseGuard = Guard.make<TestState, TestEvent>(() => true);
    const namedGuard = Guard.named("myGuard", baseGuard);

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(
              TestState.Idle,
              TestEvent.Fetch,
              ({ event }) => TestState.Loading({ url: event.url }),
              {
                guard: namedGuard,
              },
            ),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    const guardEvent = events.find((e) => e.type === "@machine.guard");
    expect(guardEvent).toBeDefined();
    expect((guardEvent as { guardName: string }).guardName).toBe("myGuard");
  });

  test("composite guard names", async () => {
    const guardA = Guard.make<TestState, TestEvent>(() => true, "guardA");
    const guardB = Guard.make<TestState, TestEvent>(() => true, "guardB");
    const combined = Guard.and(guardA, guardB);

    expect(combined.name).toBe("and(guardA, guardB)");

    const orCombined = Guard.or(guardA, guardB);
    expect(orCombined.name).toBe("or(guardA, guardB)");

    const negated = Guard.not(guardA);
    expect(negated.name).toBe("not(guardA)");
  });

  test("event order is correct", async () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    const canFetch = Guard.make<TestState, TestEvent>(() => true, "canFetch");

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<TestState, TestEvent>(TestState.Idle()).pipe(
            Machine.on(
              TestState.Idle,
              TestEvent.Fetch,
              ({ event }) => TestState.Loading({ url: event.url }),
              {
                guard: canFetch,
              },
            ),
            Machine.onExit(TestState.Idle, () => Effect.void),
            Machine.onEnter(TestState.Loading, () => Effect.void),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("test", machine);

        yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
        yield* yieldFibers;
      }).pipe(
        Effect.scoped,
        Effect.provide(ActorSystemDefault),
        Effect.provideService(InspectorService, collectingInspector(events)),
      ),
    );

    // Filter to events between spawn and stop (the transition events)
    const transitionEvents = events.slice(1, -1); // Remove spawn at start and stop at end

    // Expected order: event received -> guard -> exit effect -> transition -> entry effect
    const types = transitionEvents.map((e) => e.type);
    expect(types).toEqual([
      "@machine.event",
      "@machine.guard",
      "@machine.effect", // exit
      "@machine.transition",
      "@machine.effect", // entry
    ]);
  });
});
