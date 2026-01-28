// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Ref, Schema } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  type MachineType,
  MissingSlotHandlerError,
  simulate,
  State,
  UnknownSlotError,
  UnprovidedSlotsError,
} from "../../src/index.js";
import { describe, expect, it, test, yieldFibers } from "../utils/effect-test.js";

describe("Effect Slots", () => {
  const FetchState = State({
    Idle: {},
    Loading: { url: Schema.String },
    Success: { data: Schema.String },
    Error: { message: Schema.String },
  });
  type FetchState = typeof FetchState.Type;

  const FetchEvent = Event({
    Fetch: { url: Schema.String },
    Resolve: { data: Schema.String },
    Reject: { message: Schema.String },
  });
  type FetchEvent = typeof FetchEvent.Type;

  // Machine with effect slots
  const baseMachine = Machine.make({
    state: FetchState,
    event: FetchEvent,
    initial: FetchState.Idle,
  })
    .on(FetchState.Idle, FetchEvent.Fetch, ({ event }) => FetchState.Loading({ url: event.url }))
    .on(FetchState.Loading, FetchEvent.Resolve, ({ event }) =>
      FetchState.Success({ data: event.data }),
    )
    .on(FetchState.Loading, FetchEvent.Reject, ({ event }) =>
      FetchState.Error({ message: event.message }),
    )
    .invoke(FetchState.Loading, "fetchData")
    .onEnter(FetchState.Success, "notifySuccess")
    .onExit(FetchState.Loading, "cleanup")
    .final(FetchState.Success)
    .final(FetchState.Error);

  test("effectSlots tracks slot names", () => {
    const built = baseMachine;

    expect(built.effectSlots.size).toBe(3);
    expect(built.effectSlots.has("fetchData")).toBe(true);
    expect(built.effectSlots.has("notifySuccess")).toBe(true);
    expect(built.effectSlots.has("cleanup")).toBe(true);

    const fetchDataSlot = built.effectSlots.get("fetchData");
    expect(fetchDataSlot?.type).toBe("invoke");
    expect(fetchDataSlot?.stateTag).toBe("Loading");

    const notifySlot = built.effectSlots.get("notifySuccess");
    expect(notifySlot?.type).toBe("onEnter");
    expect(notifySlot?.stateTag).toBe("Success");

    const cleanupSlot = built.effectSlots.get("cleanup");
    expect(cleanupSlot?.type).toBe("onExit");
    expect(cleanupSlot?.stateTag).toBe("Loading");
  });

  it.live("simulate() works without providing effects", () =>
    Effect.gen(function* () {
      const built = baseMachine;

      // simulate() only runs transitions, not effects - so it works with unprovided slots
      const result = yield* simulate(built, [
        FetchEvent.Fetch({ url: "/api" }),
        FetchEvent.Resolve({ data: "mock data" }),
      ]);

      expect(result.finalState._tag).toBe("Success");
      expect((result.finalState as FetchState & { _tag: "Success" }).data).toBe("mock data");
      expect(result.states.map((s) => s._tag)).toEqual(["Idle", "Loading", "Success"]);
    }),
  );

  it.scopedLive("provide wires in effect handlers", () =>
    Effect.gen(function* () {
      const log: string[] = [];

      // Provide effect implementations via fluent API
      const providedMachine = baseMachine.provide({
        fetchData: ({ self }) =>
          Effect.gen(function* () {
            log.push("fetchData:start");
            // In real usage, this would make an HTTP call
            // For testing, we immediately send a resolve event
            yield* self.send(FetchEvent.Resolve({ data: "fetched" }));
            log.push("fetchData:done");
          }),
        notifySuccess: ({ state }) =>
          Effect.sync(() =>
            log.push(`notifySuccess:${(state as FetchState & { _tag: "Success" }).data}`),
          ),
        cleanup: () => Effect.sync(() => log.push("cleanup")),
      });

      // Verify effectSlots is now empty (all provided)
      expect(providedMachine.effectSlots.size).toBe(0);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("fetcher", providedMachine);

      yield* actor.send(FetchEvent.Fetch({ url: "/api" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Success");

      // Verify effects ran in correct order
      expect(log).toEqual([
        "fetchData:start",
        "fetchData:done",
        "cleanup",
        "notifySuccess:fetched",
      ]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("can swap effect implementations for testing", () =>
    Effect.gen(function* () {
      const mockData = yield* Ref.make<string>("test-mock-data");

      // Test implementation - uses mock data
      const testMachine = baseMachine.provide({
        fetchData: ({ self }) =>
          Effect.gen(function* () {
            const data = yield* Ref.get(mockData);
            yield* self.send(FetchEvent.Resolve({ data }));
          }),
        notifySuccess: () => Effect.void, // No-op in tests
        cleanup: () => Effect.void, // No-op in tests
      });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test-fetcher", testMachine);

      yield* actor.send(FetchEvent.Fetch({ url: "/api" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Success");
      expect((state as FetchState & { _tag: "Success" }).data).toBe("test-mock-data");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  test("provide throws on missing handler", () => {
    try {
      // @ts-expect-error - intentionally missing handlers for testing
      baseMachine.provide({
        fetchData: () => Effect.void,
        // Missing notifySuccess and cleanup
      });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSlotHandlerError);
      expect((e as MissingSlotHandlerError).slotName).toBe("notifySuccess");
    }
  });

  test("provide throws on extra handler", () => {
    try {
      baseMachine.provide({
        fetchData: () => Effect.void,
        notifySuccess: () => Effect.void,
        cleanup: () => Effect.void,
        // @ts-expect-error - extra handler for testing
        unknownSlot: () => Effect.void,
      });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSlotError);
      expect((e as UnknownSlotError).slotName).toBe("unknownSlot");
    }
  });

  it.scopedLive("spawning unprovided machine throws runtime error", () =>
    Effect.gen(function* () {
      // Note: TypeScript doesn't catch this at compile time because Slots is a phantom type.
      // The runtime validation in spawn() will catch it.
      // We use a type assertion to bypass the type check for testing.
      type ProvidedMachineType = MachineType<FetchState, FetchEvent, never, never>;

      const system = yield* ActorSystemService;

      let caughtError: UnprovidedSlotsError | undefined;
      yield* system.spawn("bad", baseMachine as unknown as ProvidedMachineType).pipe(
        Effect.catchAllDefect((defect) => {
          caughtError = defect as UnprovidedSlotsError;
          return Effect.void;
        }),
      );

      expect(caughtError).toBeDefined();
      expect(caughtError).toBeInstanceOf(UnprovidedSlotsError);
      expect(caughtError!.slots).toContain("fetchData");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("provide is chainable", () =>
    Effect.gen(function* () {
      const log: string[] = [];

      // Using fluent chaining with provide at the end
      const providedMachine = Machine.make({
        state: FetchState,
        event: FetchEvent,
        initial: FetchState.Idle,
      })
        .on(FetchState.Idle, FetchEvent.Fetch, ({ event }) =>
          FetchState.Loading({ url: event.url }),
        )
        .on(FetchState.Loading, FetchEvent.Resolve, ({ event }) =>
          FetchState.Success({ data: event.data }),
        )
        .invoke(FetchState.Loading, "fetchData")
        .onEnter(FetchState.Success, "notify")
        .final(FetchState.Success)
        .provide({
          fetchData: ({ self }) =>
            Effect.gen(function* () {
              log.push("fetch");
              yield* self.send(FetchEvent.Resolve({ data: "piped" }));
            }),
          notify: () => Effect.sync(() => log.push("notify")),
        });

      expect(providedMachine.effectSlots.size).toBe(0);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("piped", providedMachine);

      yield* actor.send(FetchEvent.Fetch({ url: "/api" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Success");
      expect(log).toEqual(["fetch", "notify"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("final state notifies listeners exactly once", () =>
    Effect.gen(function* () {
      const notifications: string[] = [];

      const TestState = State({
        Idle: {},
        Done: {},
      });

      const TestEvent = Event({
        Finish: {},
      });

      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
        .final(TestState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Subscribe to state changes
      actor.subscribe((state) => {
        notifications.push(state._tag);
      });

      yield* actor.send(TestEvent.Finish);
      yield* yieldFibers;

      // Should have exactly 1 "Done" notification (not 2 from the bug)
      expect(notifications.filter((n) => n === "Done").length).toBe(1);
      expect(notifications).toEqual(["Done"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("invoke cancels on state exit", () =>
    Effect.gen(function* () {
      const log: string[] = [];

      const TimerState = State({
        Running: {},
        Stopped: {},
      });

      const TimerEvent = Event({
        Stop: {},
        Tick: {},
      });

      const timerMachine = Machine.make({
        state: TimerState,
        event: TimerEvent,
        initial: TimerState.Running,
      })
        .on(TimerState.Running, TimerEvent.Stop, () => TimerState.Stopped)
        .invoke(TimerState.Running, "runTimer")
        .final(TimerState.Stopped)
        .provide({
          runTimer: () =>
            Effect.gen(function* () {
              log.push("timer:start");
              yield* Effect.sleep("10 seconds");
              log.push("timer:done"); // Should not run if cancelled
            }).pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  log.push("timer:interrupted");
                }),
              ),
            ),
        });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("timer", timerMachine);

      // Give the timer a chance to start
      yield* yieldFibers;

      expect(log).toEqual(["timer:start"]);

      // Stop should cancel the invoke
      yield* actor.send(TimerEvent.Stop);
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Stopped");
      expect(log).toEqual(["timer:start", "timer:interrupted"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
