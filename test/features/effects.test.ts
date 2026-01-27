// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Ref, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  type MachineType,
  simulate,
  State,
  yieldFibers,
} from "../../src/index.js";

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
    initial: FetchState.Idle(),
  }).pipe(
    Machine.on(FetchState.Idle, FetchEvent.Fetch, ({ event }) =>
      FetchState.Loading({ url: event.url }),
    ),
    Machine.on(FetchState.Loading, FetchEvent.Resolve, ({ event }) =>
      FetchState.Success({ data: event.data }),
    ),
    Machine.on(FetchState.Loading, FetchEvent.Reject, ({ event }) =>
      FetchState.Error({ message: event.message }),
    ),
    Machine.invoke(FetchState.Loading, "fetchData"),
    Machine.onEnter(FetchState.Success, "notifySuccess"),
    Machine.onExit(FetchState.Loading, "cleanup"),
    Machine.final(FetchState.Success),
    Machine.final(FetchState.Error),
  );

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

  test("simulate() works without providing effects", async () => {
    await Effect.runPromise(
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
  });

  test("Machine.provide wires in effect handlers", async () => {
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const built = baseMachine;

        // Provide effect implementations
        const providedMachine = Machine.provide(built, {
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
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("can swap effect implementations for testing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const built = baseMachine;

        const mockData = yield* Ref.make<string>("test-mock-data");

        // Test implementation - uses mock data
        const testMachine = Machine.provide(built, {
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
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("Machine.provide throws on missing handler", () => {
    const built = baseMachine;

    expect(() => {
      // @ts-expect-error - intentionally missing handlers for testing
      Machine.provide(built, {
        fetchData: () => Effect.void,
        // Missing notifySuccess and cleanup
      });
    }).toThrow('Missing handler for effect slot "notifySuccess"');
  });

  test("Machine.provide throws on extra handler", () => {
    const built = baseMachine;

    expect(() => {
      Machine.provide(built, {
        fetchData: () => Effect.void,
        notifySuccess: () => Effect.void,
        cleanup: () => Effect.void,
        // @ts-expect-error - extra handler for testing
        unknownSlot: () => Effect.void,
      });
    }).toThrow('Unknown effect slot "unknownSlot"');
  });

  test("spawning unprovided machine throws runtime error", async () => {
    const built = baseMachine;

    // Note: TypeScript doesn't catch this at compile time because Slots is a phantom type.
    // The runtime validation in spawn() will catch it.
    // We use a type assertion to bypass the type check for testing.
    type ProvidedMachineType = MachineType<FetchState, FetchEvent, never, never>;

    const program = Effect.gen(function* () {
      const system = yield* ActorSystemService;
      yield* system.spawn("bad", built as unknown as ProvidedMachineType);
    }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault));

    // The error should be thrown when attempting to spawn
    try {
      await Effect.runPromise(program);
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("unprovided effect slots");
      expect((e as Error).message).toContain("fetchData");
    }
  });

  test("Machine.provide is pipeable (data-last)", async () => {
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        // Using the pipeable form - handlers first, then machine
        const providedMachine = Machine.make({
          state: FetchState,
          event: FetchEvent,
          initial: FetchState.Idle(),
        }).pipe(
          Machine.on(FetchState.Idle, FetchEvent.Fetch, ({ event }) =>
            FetchState.Loading({ url: event.url }),
          ),
          Machine.on(FetchState.Loading, FetchEvent.Resolve, ({ event }) =>
            FetchState.Success({ data: event.data }),
          ),
          Machine.invoke(FetchState.Loading, "fetchData"),
          Machine.onEnter(FetchState.Success, "notify"),
          Machine.final(FetchState.Success),
          Machine.provide({
            fetchData: ({ self }) =>
              Effect.gen(function* () {
                log.push("fetch");
                yield* self.send(FetchEvent.Resolve({ data: "piped" }));
              }),
            notify: () => Effect.sync(() => log.push("notify")),
          }),
        );

        expect(providedMachine.effectSlots.size).toBe(0);

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("piped", providedMachine);

        yield* actor.send(FetchEvent.Fetch({ url: "/api" }));
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Success");
        expect(log).toEqual(["fetch", "notify"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("invoke cancels on state exit", async () => {
    const log: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const TimerState = State({
          Running: {},
          Stopped: {},
        });
        type TimerState = typeof TimerState.Type;

        const TimerEvent = Event({
          Stop: {},
          Tick: {},
        });
        type TimerEvent = typeof TimerEvent.Type;

        const timerMachine = Machine.make({
          state: TimerState,
          event: TimerEvent,
          initial: TimerState.Running(),
        }).pipe(
          Machine.on(TimerState.Running, TimerEvent.Stop, () => TimerState.Stopped()),
          Machine.invoke(TimerState.Running, "runTimer"),
          Machine.final(TimerState.Stopped),
        );

        const providedMachine = Machine.provide(timerMachine, {
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
        const actor = yield* system.spawn("timer", providedMachine);

        // Give the timer a chance to start
        yield* yieldFibers;

        expect(log).toEqual(["timer:start"]);

        // Stop should cancel the invoke
        yield* actor.send(TimerEvent.Stop());
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Stopped");
        expect(log).toEqual(["timer:start", "timer:interrupted"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
