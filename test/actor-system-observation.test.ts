// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Fiber, Stream } from "effect";

import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "../src/index.js";
import type { SystemEvent } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

// ============================================================================
// Test machines
// ============================================================================

const TestState = State({
  Idle: {},
  Active: {},
  Done: {},
});

const TestEvent = Event({
  Activate: {},
  Finish: {},
});

const testMachine = Machine.make({
  state: TestState,
  event: TestEvent,
  initial: TestState.Idle,
})
  .on(TestState.Idle, TestEvent.Activate, () => TestState.Active)
  .on(TestState.Active, TestEvent.Finish, () => TestState.Done)
  .final(TestState.Done)
  .build();

// ============================================================================
// Tests
// ============================================================================

describe("ActorSystem Observation", () => {
  describe("subscribe (sync)", () => {
    it.scopedLive("receives ActorSpawned on spawn", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];
        system.subscribe((e) => events.push(e));

        yield* system.spawn("a1", testMachine);

        expect(events).toHaveLength(1);
        expect(events[0]!._tag).toBe("ActorSpawned");
        expect(events[0]!.id).toBe("a1");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("receives ActorStopped on system.stop", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];

        yield* system.spawn("a1", testMachine);

        system.subscribe((e) => events.push(e));

        yield* system.stop("a1");

        expect(events).toHaveLength(1);
        expect(events[0]!._tag).toBe("ActorStopped");
        expect(events[0]!.id).toBe("a1");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("unsubscribe stops delivery", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];
        const unsub = system.subscribe((e) => events.push(e));

        yield* system.spawn("a1", testMachine);
        expect(events).toHaveLength(1);

        unsub();

        yield* system.spawn("a2", testMachine);
        // Should still be 1 — no new events after unsubscribe
        expect(events).toHaveLength(1);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("listener errors don't crash system", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];

        // First listener throws
        system.subscribe(() => {
          throw new Error("boom");
        });
        // Second listener should still receive events
        system.subscribe((e) => events.push(e));

        yield* system.spawn("a1", testMachine);

        expect(events).toHaveLength(1);
        expect(events[0]!._tag).toBe("ActorSpawned");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("multiple subscribers receive same events", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events1: SystemEvent[] = [];
        const events2: SystemEvent[] = [];

        system.subscribe((e) => events1.push(e));
        system.subscribe((e) => events2.push(e));

        yield* system.spawn("a1", testMachine);

        expect(events1).toHaveLength(1);
        expect(events2).toHaveLength(1);
        expect(events1[0]!.id).toBe("a1");
        expect(events2[0]!.id).toBe("a1");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("actors (sync snapshot)", () => {
    it.scopedLive("starts empty, grows on spawn, shrinks on stop", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;

        expect(system.actors.size).toBe(0);

        yield* system.spawn("a1", testMachine);
        expect(system.actors.size).toBe(1);
        expect(system.actors.has("a1")).toBe(true);

        yield* system.spawn("a2", testMachine);
        expect(system.actors.size).toBe(2);

        yield* system.stop("a1");
        expect(system.actors.size).toBe(1);
        expect(system.actors.has("a1")).toBe(false);
        expect(system.actors.has("a2")).toBe(true);

        yield* system.stop("a2");
        expect(system.actors.size).toBe(0);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("returns snapshot, not live view", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;

        yield* system.spawn("a1", testMachine);
        const snapshot = system.actors;
        expect(snapshot.size).toBe(1);

        yield* system.spawn("a2", testMachine);
        // snapshot captured before a2 — should still be 1
        expect(snapshot.size).toBe(1);
        // fresh access should be 2
        expect(system.actors.size).toBe(2);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("events (async stream)", () => {
    it.scopedLive("emits spawn and stop events", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;

        // Collect 2 events from stream in background
        const fiber = yield* Stream.runCollect(system.events.pipe(Stream.take(2))).pipe(
          Effect.fork,
        );

        // Give the stream subscription time to register
        yield* Effect.yieldNow();
        yield* yieldFibers;

        yield* system.spawn("a1", testMachine);
        yield* Effect.yieldNow();
        yield* yieldFibers;

        yield* system.stop("a1");
        yield* Effect.yieldNow();
        yield* yieldFibers;

        const collected = Array.from(yield* fiber.pipe(Fiber.join));

        expect(collected).toHaveLength(2);
        expect(collected[0]!._tag).toBe("ActorSpawned");
        expect(collected[0]!.id).toBe("a1");
        expect(collected[1]!._tag).toBe("ActorStopped");
        expect(collected[1]!.id).toBe("a1");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });

  describe("implicit system", () => {
    it.scopedLive("Machine.spawn actor has observable system", () =>
      Effect.gen(function* () {
        const events: SystemEvent[] = [];
        const actor = yield* Machine.spawn(testMachine);

        actor.system.subscribe((e) => events.push(e));
        expect(actor.system.actors).toBeDefined();

        yield* actor.stop;
      }),
    );
  });

  describe("edge cases", () => {
    it.scopedLive("stopped event includes actor ref with readable final state", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];
        system.subscribe((e) => events.push(e));

        const actor = yield* system.spawn("a1", testMachine);
        yield* actor.send(TestEvent.Activate);
        yield* Effect.yieldNow();
        yield* yieldFibers;

        yield* system.stop("a1");

        const stoppedEvent = events.find((e) => e._tag === "ActorStopped");
        expect(stoppedEvent).toBeDefined();
        // Actor ref in event should still have readable state
        const state = stoppedEvent!.actor.snapshotSync();
        expect(state._tag).toBe("Active");
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("no double ActorStopped when system.stop + scope finalizer both fire", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];
        system.subscribe((e) => events.push(e));

        yield* system.spawn("a1", testMachine);
        yield* system.stop("a1");

        // Count stopped events for a1
        const stoppedCount = events.filter(
          (e) => e._tag === "ActorStopped" && e.id === "a1",
        ).length;
        expect(stoppedCount).toBe(1);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );

    it.scopedLive("scope-based cleanup emits ActorStopped", () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const events: SystemEvent[] = [];
        system.subscribe((e) => events.push(e));

        // Spawn in a nested scope that closes before system teardown
        yield* Effect.scoped(system.spawn("scoped-1", testMachine).pipe(Effect.asVoid));

        // Scope closed — should have spawned + stopped
        const spawned = events.filter((e) => e._tag === "ActorSpawned" && e.id === "scoped-1");
        const stopped = events.filter((e) => e._tag === "ActorStopped" && e.id === "scoped-1");
        expect(spawned).toHaveLength(1);
        expect(stopped).toHaveLength(1);
      }).pipe(Effect.provide(ActorSystemDefault)),
    );
  });
});
