// @effect-diagnostics strictEffectProvide:off,missingEffectContext:off,anyUnknownInErrorContext:off - tests are entry points
import { Effect, Ref, Schema } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  MissingSlotHandlerError,
  simulate,
  State,
  UnknownSlotError,
  Slot,
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
    .onEnter(FetchState.Success, ({ state }) =>
      Effect.log(`Success: ${(state as FetchState & { _tag: "Success" }).data}`),
    )
    .onExit(FetchState.Loading, () => Effect.log("Cleanup"))
    .final(FetchState.Success)
    .final(FetchState.Error);

  test("effectSlots tracks slot names", () => {
    expect(baseMachine.effectSlots.size).toBe(1); // only invoke is a slot
    expect(baseMachine.effectSlots.has("fetchData")).toBe(true);

    const fetchDataSlot = baseMachine.effectSlots.get("fetchData");
    expect(fetchDataSlot?.type).toBe("invoke");
    expect(fetchDataSlot?.stateTag).toBe("Loading");
  });

  it.live("simulate() works without providing effects", () =>
    Effect.gen(function* () {
      // simulate() only runs transitions, not effects - so it works with unprovided slots
      const result = yield* simulate(baseMachine, [
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
            yield* self.send(FetchEvent.Resolve({ data: "fetched" }));
            log.push("fetchData:done");
          }),
      });

      // Verify effectSlots is now empty (all provided)
      expect(providedMachine.effectSlots.size).toBe(0);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("fetcher", providedMachine);

      yield* actor.send(FetchEvent.Fetch({ url: "/api" }));
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Success");

      // Verify effects ran
      expect(log).toContain("fetchData:start");
      expect(log).toContain("fetchData:done");
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
    const machineWithSlot = Machine.make({
      state: FetchState,
      event: FetchEvent,
      initial: FetchState.Idle,
    }).invoke(FetchState.Loading, "fetchData");

    try {
      // @ts-expect-error - intentionally missing handlers for testing
      machineWithSlot.provide({});
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSlotHandlerError);
      expect((e as MissingSlotHandlerError).slotName).toBe("fetchData");
    }
  });

  test("provide throws on extra handler", () => {
    const machineWithSlot = Machine.make({
      state: FetchState,
      event: FetchEvent,
      initial: FetchState.Idle,
    }).invoke(FetchState.Loading, "fetchData");

    try {
      machineWithSlot.provide({
        fetchData: () => Effect.void,
        // @ts-expect-error - extra handler for testing
        unknownSlot: () => Effect.void,
      });
      expect.unreachable("Should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnknownSlotError);
      expect((e as UnknownSlotError).slotName).toBe("unknownSlot");
    }
  });

  // Note: Runtime unprovided machine test removed because type-level enforcement
  // makes it impossible to spawn an unprovided machine without `as any` casts,
  // and the Effect Language Service flags those as errors.
});

describe("Parameterized Effect Slots", () => {
  const NotifyState = State({
    Idle: {},
    Notifying: {},
    Done: {},
  });

  const NotifyEvent = Event({
    Send: { message: Schema.String },
    Complete: {},
  });

  const NotifyEffects = Slot.Effects({
    notify: { message: Schema.String },
  });

  test("effect slot with parameters", async () => {
    const logs: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: NotifyState,
          event: NotifyEvent,
          effects: NotifyEffects,
          initial: NotifyState.Idle,
        })
          .on(NotifyState.Idle, NotifyEvent.Send, ({ event, effects }) =>
            Effect.gen(function* () {
              yield* effects.notify({ message: event.message });
              return NotifyState.Notifying;
            }),
          )
          .on(NotifyState.Notifying, NotifyEvent.Complete, () => NotifyState.Done)
          .final(NotifyState.Done)
          .provide({
            notify: ({ message }) =>
              Effect.sync(() => {
                logs.push(`Notified: ${message}`);
              }),
          });

        const result = yield* simulate(machine, [
          NotifyEvent.Send({ message: "Hello World" }),
          NotifyEvent.Complete,
        ]);

        expect(result.finalState._tag).toBe("Done");
        expect(logs).toEqual(["Notified: Hello World"]);
      }),
    );
  });
});
