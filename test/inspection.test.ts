// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Duration, Effect, Schema } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  type AnyInspectionEvent,
  combineInspectors,
  collectingInspector,
  type InspectionEvent,
  makeInspector,
  makeInspectorEffect,
  InspectorService,
  Machine,
  State,
  Supervision,
  tracingInspector,
  Event,
} from "../src/index.js";
import { makeSystem } from "../src/actor.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

/** Thrown by a deliberately-failing inspector to prove it does not crash the machine. */
class InspectorBoomError extends Data.TaggedError(
  "effect-machine/test/inspection.test/InspectorBoomError",
)<{
  readonly message: string;
}> {}

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

  it.scopedLive("uses the spawn inspector instead of the ambient inspector", () => {
    const ambientEvents: InspectionEvent<TestState, TestEvent>[] = [];
    const spawnEvents: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("spawn-inspector", machine, {
        inspect: collectingInspector(spawnEvents),
      });
      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      expect(spawnEvents.some((event) => event.type === "@machine.spawn")).toBe(true);
      expect(spawnEvents.some((event) => event.type === "@machine.transition")).toBe(true);
      expect(ambientEvents).toHaveLength(0);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(ambientEvents)),
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

  it.scopedLive("reports named transition operations with actor generation", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];
    const beginFetch = ({ event }: { readonly event: Extract<TestEvent, { _tag: "Fetch" }> }) =>
      TestState.Loading({ url: event.url });

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, beginFetch);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("operation", machine);
      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      const operation = events.find((event) => event.type === "@machine.operation");
      expect(operation).toMatchObject({
        actorId: "operation",
        generation: 0,
        operation: "beginFetch",
      });
      expect(events.every((event) => event.generation === 0)).toBe(true);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("reports the new generation after supervision restarts", () => {
    const events: Array<InspectionEvent<TestState, TestEvent>> = [];
    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Fetch, () => Effect.die("restart"))
        .on(TestState.Idle, TestEvent.Reset, () => TestState.Idle);

      const actor = yield* Machine.spawn(machine, {
        id: "supervised-inspection",
        supervision: Supervision.restart({ maxRestarts: 1 }),
        inspect: collectingInspector(events),
      });
      yield* actor.start;
      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* Effect.sleep(Duration.millis(50));
      yield* actor.send(TestEvent.Reset);
      yield* yieldFibers;

      const resetEvent = events.find(
        (event) => event.type === "@machine.event" && event.event._tag === "Reset",
      );
      expect(resetEvent?.generation).toBe(1);
    });
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

  it.scopedLive("emits error event on spawn defect", () => {
    const events: InspectionEvent<TestState, TestEvent>[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).spawn(TestState.Idle, () => Effect.die("boom"));

      const system = yield* ActorSystemService;
      const spawnExit = yield* Effect.exit(system.spawn("test", machine));

      expect(spawnExit._tag).toBe("Failure");
      const errorEvent = events.find((e) => e.type === "@machine.error");
      expect(errorEvent).toBeDefined();
      if (errorEvent?.type === "@machine.error") {
        expect(errorEvent.phase).toBe("spawn");
        expect(errorEvent.error).toContain("boom");
      }
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
          throw new InspectorBoomError({ message: "boom" });
        }),
      ),
    ),
  );

  it.scopedLive("effectful inspectors run inside the actor flow", () => {
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

      expect(events.some((event) => event.type === "@machine.transition")).toBe(true);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(
        InspectorService,
        makeInspectorEffect((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      ),
    );
  });

  it.scopedLive("combined inspectors isolate failures", () => {
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

      expect(events.some((event) => event.type === "@machine.transition")).toBe(true);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(
        InspectorService,
        combineInspectors(
          makeInspectorEffect(() => Effect.die("boom")),
          collectingInspector(events),
        ),
      ),
    );
  });

  it.scopedLive("registers and unregisters system inspectors after actor startup", () => {
    const events: AnyInspectionEvent[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }))
        .on(TestState.Loading, TestEvent.Reset, () => TestState.Idle);

      const system = yield* makeSystem();
      const actor = yield* system.spawn("late-inspector", machine);

      const unregisterFailing = actor.system.inspect(
        makeInspector(() => {
          throw new InspectorBoomError({ message: "boom" });
        }),
      );
      const unregisterCollector = actor.system.inspect(collectingInspector(events));

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      expect(events.some((event) => event.type === "@machine.spawn")).toBe(false);
      expect(events.some((event) => event.type === "@machine.event")).toBe(true);
      expect(events.some((event) => event.type === "@machine.operation")).toBe(true);
      expect(events.some((event) => event.type === "@machine.transition")).toBe(true);
      expect(events.every((event) => event.generation === 0)).toBe(true);
      expect((yield* actor.snapshot)._tag).toBe("Loading");

      yield* system.spawn("other-inspected-actor", machine);
      expect(events.some((event) => event.actorId === "other-inspected-actor")).toBe(true);

      unregisterFailing();
      unregisterCollector();
      const eventCount = events.length;

      yield* actor.send(TestEvent.Reset);
      yield* yieldFibers;

      expect(events).toHaveLength(eventCount);
      expect((yield* actor.snapshot)._tag).toBe("Idle");
    });
  });

  it.scopedLive("runs actor and system inspectors in registration order", () => {
    const calls: string[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, TestEvent.Fetch, ({ event }) => TestState.Loading({ url: event.url }));
      const system = yield* ActorSystemService;
      const unregisterFirst = system.inspect(
        makeInspectorEffect((event) =>
          Effect.sync(() => {
            if (event.type === "@machine.transition") calls.push("system-first");
          }),
        ),
      );
      const unregisterSecond = system.inspect(
        makeInspectorEffect((event) =>
          Effect.sync(() => {
            if (event.type === "@machine.transition") calls.push("system-second");
          }),
        ),
      );
      const actor = yield* system.spawn("ordered-inspectors", machine, {
        inspect: makeInspectorEffect((event) =>
          Effect.sync(() => {
            if (event.type === "@machine.transition") calls.push("actor");
          }),
        ),
      });

      yield* actor.send(TestEvent.Fetch({ url: "https://example.com" }));
      yield* yieldFibers;

      expect(calls).toEqual(["actor", "system-first", "system-second"]);
      unregisterFirst();
      unregisterSecond();
    }).pipe(Effect.provide(ActorSystemDefault));
  });

  it.scopedLive("tracing inspector does not break actor processing", () =>
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
      Effect.provideService(InspectorService, tracingInspector()),
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

      // Expected order: spawn effect -> event -> operation -> transition -> spawn effect
      const types = transitionEvents.map((e) => e.type);
      expect(types).toEqual([
        "@machine.effect", // spawn on Idle entry
        "@machine.event",
        "@machine.operation",
        "@machine.transition",
        "@machine.effect", // spawn on Loading entry
      ]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("named tasks emit lifecycle inspection events", () => {
    const TaskState = State({
      Idle: {},
      Running: {},
      Done: {},
    });
    const TaskEvent = Event({
      Start: {},
      Success: {},
    });
    const events: AnyInspectionEvent[] = [];

    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TaskState,
        event: TaskEvent,
        initial: TaskState.Idle,
      })
        .on(TaskState.Idle, TaskEvent.Start, () => TaskState.Running)
        .on(TaskState.Running, TaskEvent.Success, () => TaskState.Done)
        .task(TaskState.Running, () => Effect.succeed("ok"), {
          name: "load-user",
          onSuccess: () => TaskEvent.Success,
        })
        .final(TaskState.Done);

      const system = yield* ActorSystemService;
      const unregister = system.inspect(collectingInspector(events));
      const actor = yield* system.spawn("task-events", machine);

      yield* actor.send(TaskEvent.Start);
      yield* actor.awaitFinal;

      const taskEvents = events.filter((event) => event.type === "@machine.task");
      expect(
        taskEvents.map((event) => {
          if (event.type === "@machine.task") {
            return event.phase;
          }
          return "bad";
        }),
      ).toEqual(["start", "success"]);
      for (const event of taskEvents) {
        if (event.type === "@machine.task") {
          expect(event.taskName).toBe("load-user");
        }
      }
      unregister();
    }).pipe(Effect.provide(ActorSystemDefault));
  });
});
