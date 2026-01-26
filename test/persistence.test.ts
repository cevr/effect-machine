// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, Option, Schedule, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  InMemoryPersistenceAdapter,
  Machine,
  makeInMemoryPersistenceAdapter,
  PersistenceAdapterTag,
  type PersistentActorRef,
  State,
  withPersistence,
  yieldFibers,
} from "../src/index.js";

// Test state and event types
type OrderState = State.TaggedEnum<{
  Idle: {};
  Pending: { orderId: string };
  Paid: { orderId: string; amount: number };
  Done: {};
}>;
const OrderState = State.taggedEnum<OrderState>();

type OrderEvent = Event.TaggedEnum<{
  Submit: { orderId: string };
  Pay: { amount: number };
  Complete: {};
}>;
const OrderEvent = Event.taggedEnum<OrderEvent>();

// Schemas for persistence
const StateSchema = Schema.Union(
  Schema.TaggedStruct("Idle", {}),
  Schema.TaggedStruct("Pending", { orderId: Schema.String }),
  Schema.TaggedStruct("Paid", { orderId: Schema.String, amount: Schema.Number }),
  Schema.TaggedStruct("Done", {}),
);

const EventSchema = Schema.Union(
  Schema.TaggedStruct("Submit", { orderId: Schema.String }),
  Schema.TaggedStruct("Pay", { amount: Schema.Number }),
  Schema.TaggedStruct("Complete", {}),
);

// Test layer combining ActorSystem and InMemoryPersistenceAdapter
const TestLayer = Layer.merge(ActorSystemDefault, InMemoryPersistenceAdapter);

describe("Persistence", () => {
  const createPersistentMachine = () =>
    Machine.build(
      Machine.make<OrderState, OrderEvent>(OrderState.Idle()).pipe(
        Machine.on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
          OrderState.Pending({ orderId: event.orderId }),
        ),
        Machine.on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
          OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
        ),
        Machine.on(OrderState.Paid, OrderEvent.Complete, () => OrderState.Done()),
        Machine.final(OrderState.Done),
      ),
    ).pipe(
      withPersistence({
        snapshotSchedule: Schedule.forever,
        journalEvents: true,
        stateSchema: StateSchema,
        eventSchema: EventSchema,
      }),
    );

  test("spawn persistent actor and process events", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const actor = yield* system.spawn("order-1", persistentMachine);

        // Verify initial state
        const initialState = yield* actor.snapshot;
        expect(initialState._tag).toBe("Idle");

        // Send events
        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-123" }));
        yield* yieldFibers;

        const state1 = yield* actor.snapshot;
        expect(state1._tag).toBe("Pending");
        if (state1._tag === "Pending") {
          expect(state1.orderId).toBe("ORD-123");
        }

        yield* actor.send(OrderEvent.Pay({ amount: 99.99 }));
        yield* yieldFibers;

        const state2 = yield* actor.snapshot;
        expect(state2._tag).toBe("Paid");
        if (state2._tag === "Paid") {
          expect(state2.orderId).toBe("ORD-123");
          expect(state2.amount).toBe(99.99);
        }
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });

  test("version increments on each event", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const actor = yield* system.spawn("order-2", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        // Initial version should be 0
        const v0 = yield* actor.version;
        expect(v0).toBe(0);

        // Send first event
        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-456" }));
        yield* yieldFibers;

        const v1 = yield* actor.version;
        expect(v1).toBe(1);

        // Send second event
        yield* actor.send(OrderEvent.Pay({ amount: 50 }));
        yield* yieldFibers;

        const v2 = yield* actor.version;
        expect(v2).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });

  test("restore actor from persistence", async () => {
    // Use a shared adapter for cross-scope persistence
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        // Spawn and process some events
        const actor1 = yield* system.spawn("order-3", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        yield* actor1.send(OrderEvent.Submit({ orderId: "ORD-789" }));
        yield* yieldFibers;
        yield* actor1.send(OrderEvent.Pay({ amount: 200 }));
        yield* yieldFibers;

        // Force snapshot
        yield* actor1.persist;

        // Stop the actor
        yield* system.stop("order-3");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Restore in a new scope
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        // Restore from persistence
        const maybeActor = yield* system.restore("order-3", persistentMachine);
        expect(Option.isSome(maybeActor)).toBe(true);

        if (Option.isSome(maybeActor)) {
          const actor = maybeActor.value;
          const state = yield* actor.snapshot;

          expect(state._tag).toBe("Paid");
          if (state._tag === "Paid") {
            expect(state.orderId).toBe("ORD-789");
            expect(state.amount).toBe(200);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("restore returns None for non-existent actor", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const maybeActor = yield* system.restore("non-existent", persistentMachine);
        expect(Option.isNone(maybeActor)).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });

  test("persist method forces immediate snapshot", async () => {
    // Use a shared adapter for cross-scope persistence
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;

        // Create machine with no automatic snapshots (using recurs(0) which never triggers)
        const noAutoSnapshotMachine = Machine.build(
          Machine.make<OrderState, OrderEvent>(OrderState.Idle()).pipe(
            Machine.on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
              OrderState.Pending({ orderId: event.orderId }),
            ),
            Machine.on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
              OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
            ),
          ),
        ).pipe(
          withPersistence({
            snapshotSchedule: Schedule.stop, // Never auto-snapshot
            journalEvents: true,
            stateSchema: StateSchema,
            eventSchema: EventSchema,
          }),
        );

        const actor = yield* system.spawn("order-4", noAutoSnapshotMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-PERSIST" }));
        yield* yieldFibers;

        // Force snapshot
        yield* actor.persist;

        // Stop and restore
        yield* system.stop("order-4");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Verify snapshot was saved
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const maybeActor = yield* system.restore("order-4", persistentMachine);
        expect(Option.isSome(maybeActor)).toBe(true);

        if (Option.isSome(maybeActor)) {
          const state = yield* maybeActor.value.snapshot;
          expect(state._tag).toBe("Pending");
        }
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("event journaling for replay", async () => {
    // Use a shared adapter for cross-scope persistence
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;

        // Create machine that snapshots infrequently
        const infrequentSnapshotMachine = Machine.build(
          Machine.make<OrderState, OrderEvent>(OrderState.Idle()).pipe(
            Machine.on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
              OrderState.Pending({ orderId: event.orderId }),
            ),
            Machine.on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
              OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
            ),
          ),
        ).pipe(
          withPersistence({
            snapshotSchedule: Schedule.stop, // Never auto-snapshot
            journalEvents: true,
            stateSchema: StateSchema,
            eventSchema: EventSchema,
          }),
        );

        const actor = yield* system.spawn("order-5", infrequentSnapshotMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        // Only snapshot at Idle state
        yield* actor.persist;

        // Process events (not snapshotted automatically)
        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-REPLAY" }));
        yield* yieldFibers;
        yield* actor.send(OrderEvent.Pay({ amount: 300 }));
        yield* yieldFibers;

        yield* system.stop("order-5");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Restore should replay events from journal
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const maybeActor = yield* system.restore("order-5", persistentMachine);
        expect(Option.isSome(maybeActor)).toBe(true);

        if (Option.isSome(maybeActor)) {
          const state = yield* maybeActor.value.snapshot;
          // Should have replayed events to reach Paid state
          expect(state._tag).toBe("Paid");
          if (state._tag === "Paid") {
            expect(state.orderId).toBe("ORD-REPLAY");
            expect(state.amount).toBe(300);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("spawn auto-restores from existing persistence", async () => {
    // Use a shared adapter for cross-scope persistence
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    // First, create and persist an actor
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const actor = yield* system.spawn("order-6", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-AUTO" }));
        yield* yieldFibers;
        yield* actor.persist;

        yield* system.stop("order-6");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Spawn again - should auto-restore
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        // spawn with same ID should restore from persistence
        const actor = yield* system.spawn("order-6", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Pending");
        if (state._tag === "Pending") {
          expect(state.orderId).toBe("ORD-AUTO");
        }
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("PersistentActorRef has all ActorRef methods", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const actor = yield* system.spawn("order-7", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        // Test ActorRef methods work
        expect(actor.id).toBe("order-7");

        const canSubmit = yield* actor.can(OrderEvent.Submit({ orderId: "test" }));
        expect(canSubmit).toBe(true);

        const canPay = yield* actor.can(OrderEvent.Pay({ amount: 10 }));
        expect(canPay).toBe(false); // Can't pay in Idle state

        const matchesIdle = yield* actor.matches("Idle");
        expect(matchesIdle).toBe(true);

        // Sync methods
        expect(actor.matchesSync("Idle")).toBe(true);
        expect(actor.canSync(OrderEvent.Submit({ orderId: "test" }))).toBe(true);

        // Subscribe
        const states: string[] = [];
        const unsubscribe = actor.subscribe((s) => states.push(s._tag));

        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-SUB" }));
        yield* yieldFibers;

        expect(states).toContain("Pending");

        unsubscribe();
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });

  test("final state stops actor properly", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine();

        const actor = yield* system.spawn("order-8", persistentMachine) as Effect.Effect<
          PersistentActorRef<OrderState, OrderEvent>
        >;

        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-FINAL" }));
        yield* yieldFibers;
        yield* actor.send(OrderEvent.Pay({ amount: 100 }));
        yield* yieldFibers;
        yield* actor.send(OrderEvent.Complete());
        yield* yieldFibers;

        const state = yield* actor.snapshot;
        expect(state._tag).toBe("Done");
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });
});
