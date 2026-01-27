// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, Option, Schedule, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import {
  type ActorMetadata,
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
type OrderState = State<{
  Idle: {};
  Pending: { orderId: string };
  Paid: { orderId: string; amount: number };
  Done: {};
}>;
const OrderState = State<OrderState>();

type OrderEvent = Event<{
  Submit: { orderId: string };
  Pay: { amount: number };
  Complete: {};
}>;
const OrderEvent = Event<OrderEvent>();

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

describe("Persistence Registry", () => {
  const createPersistentMachine = (machineType?: string) =>
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
        machineType,
      }),
    );

  test("listPersisted returns empty for no actors", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actors = yield* system.listPersisted();
        expect(actors).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(TestLayer)),
    );
  });

  test("listPersisted shows spawned actors with metadata", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        // Spawn an actor
        const actor = yield* system.spawn("order-reg-1", persistentMachine);
        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-1" }));
        yield* yieldFibers;

        // List should show it
        const actors = yield* system.listPersisted();
        expect(actors.length).toBe(1);
        expect(actors[0]?.id).toBe("order-reg-1");
        expect(actors[0]?.machineType).toBe("orders");
        expect(actors[0]?.stateTag).toBe("Pending");
        expect(actors[0]?.version).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("restoreMany restores multiple actors", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    // First spawn some actors
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const actor1 = yield* system.spawn("order-m-1", persistentMachine);
        yield* actor1.send(OrderEvent.Submit({ orderId: "ORD-A" }));
        yield* yieldFibers;

        const actor2 = yield* system.spawn("order-m-2", persistentMachine);
        yield* actor2.send(OrderEvent.Submit({ orderId: "ORD-B" }));
        yield* yieldFibers;
        yield* actor2.send(OrderEvent.Pay({ amount: 50 }));
        yield* yieldFibers;
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Restore in new scope
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const result = yield* system.restoreMany(["order-m-1", "order-m-2"], persistentMachine);

        expect(result.restored.length).toBe(2);
        expect(result.failed.length).toBe(0);

        // Verify states
        const state1 = yield* result.restored[0]!.snapshot;
        expect(state1._tag).toBe("Pending");

        const state2 = yield* result.restored[1]!.snapshot;
        expect(state2._tag).toBe("Paid");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("restoreMany reports failures for non-existent actors", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    // Spawn one actor
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const actor = yield* system.spawn("order-exists", persistentMachine);
        yield* actor.send(OrderEvent.Submit({ orderId: "ORD-X" }));
        yield* yieldFibers;
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Try to restore one that exists and one that doesn't
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const result = yield* system.restoreMany(
          ["order-exists", "order-not-found"],
          persistentMachine,
        );

        expect(result.restored.length).toBe(1);
        expect(result.failed.length).toBe(1);
        expect(result.failed[0]?.id).toBe("order-not-found");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("restoreAll restores actors by machineType", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    // Spawn actors of different types
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const orderMachine = createPersistentMachine("orders");
        const invoiceMachine = createPersistentMachine("invoices");

        const order1 = yield* system.spawn("order-all-1", orderMachine);
        yield* order1.send(OrderEvent.Submit({ orderId: "O1" }));
        yield* yieldFibers;

        const order2 = yield* system.spawn("order-all-2", orderMachine);
        yield* order2.send(OrderEvent.Submit({ orderId: "O2" }));
        yield* yieldFibers;

        const invoice1 = yield* system.spawn("invoice-1", invoiceMachine);
        yield* invoice1.send(OrderEvent.Submit({ orderId: "I1" }));
        yield* yieldFibers;
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Restore only orders
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const orderMachine = createPersistentMachine("orders");

        const result = yield* system.restoreAll(orderMachine);

        expect(result.restored.length).toBe(2);
        expect(result.failed.length).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("restoreAll filters by stateTag", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    // Spawn actors in different states
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const pendingActor = yield* system.spawn("order-f-1", persistentMachine);
        yield* pendingActor.send(OrderEvent.Submit({ orderId: "P1" }));
        yield* yieldFibers;

        const paidActor = yield* system.spawn("order-f-2", persistentMachine);
        yield* paidActor.send(OrderEvent.Submit({ orderId: "P2" }));
        yield* yieldFibers;
        yield* paidActor.send(OrderEvent.Pay({ amount: 100 }));
        yield* yieldFibers;
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );

    // Restore only Pending orders
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const result = yield* system.restoreAll(persistentMachine, {
          filter: (meta: ActorMetadata) => meta.stateTag === "Pending",
        });

        expect(result.restored.length).toBe(1);
        expect(result.failed.length).toBe(0);

        const state = yield* result.restored[0]!.snapshot;
        expect(state._tag).toBe("Pending");
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("metadata tracks stateTag changes", async () => {
    const sharedAdapter = await Effect.runPromise(makeInMemoryPersistenceAdapter);
    const sharedLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, sharedAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const persistentMachine = createPersistentMachine("orders");

        const actor = yield* system.spawn("order-track", persistentMachine);

        // Initial state
        let actors = yield* system.listPersisted();
        expect(actors[0]?.stateTag).toBe("Idle");

        // Transition to Pending
        yield* actor.send(OrderEvent.Submit({ orderId: "T1" }));
        yield* yieldFibers;

        actors = yield* system.listPersisted();
        expect(actors[0]?.stateTag).toBe("Pending");
        expect(actors[0]?.version).toBe(1);

        // Transition to Paid
        yield* actor.send(OrderEvent.Pay({ amount: 50 }));
        yield* yieldFibers;

        actors = yield* system.listPersisted();
        expect(actors[0]?.stateTag).toBe("Paid");
        expect(actors[0]?.version).toBe(2);
      }).pipe(Effect.scoped, Effect.provide(sharedLayer)),
    );
  });

  test("listPersisted gracefully degrades without registry support", async () => {
    // Create a minimal adapter without registry methods
    const minimalAdapter = {
      saveSnapshot: () => Effect.void,
      loadSnapshot: () => Effect.succeed(Option.none()),
      appendEvent: () => Effect.void,
      loadEvents: () => Effect.succeed([]),
      deleteActor: () => Effect.void,
      // No listActors, saveMetadata, deleteMetadata
    };

    const minimalLayer = Layer.merge(
      ActorSystemDefault,
      Layer.succeed(PersistenceAdapterTag, minimalAdapter),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actors = yield* system.listPersisted();
        expect(actors).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(minimalLayer)),
    );
  });
});
