// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, Option, Schedule, Schema } from "effect";

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
  type PersistentMachine,
  State,
} from "../src/index.js";
import { describe, expect, it, yieldFibers } from "./utils/effect-test.js";

// Test state and event types using MachineSchema pattern
const OrderState = State({
  Idle: {},
  Pending: { orderId: Schema.String },
  Paid: { orderId: Schema.String, amount: Schema.Number },
  Done: {},
});
type OrderState = typeof OrderState.Type;

const OrderEvent = Event({
  Submit: { orderId: Schema.String },
  Pay: { amount: Schema.Number },
  Complete: {},
});
type OrderEvent = typeof OrderEvent.Type;

// Test layer combining ActorSystem and InMemoryPersistenceAdapter
const TestLayer = Layer.merge(ActorSystemDefault, InMemoryPersistenceAdapter);

describe("Persistence", () => {
  const createPersistentMachine = (): PersistentMachine<OrderState, OrderEvent> =>
    Machine.make({
      state: OrderState,
      event: OrderEvent,
      initial: OrderState.Idle,
    })
      .on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
        OrderState.Pending({ orderId: event.orderId }),
      )
      .on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
        OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
      )
      .on(OrderState.Paid, OrderEvent.Complete, () => OrderState.Done)
      .final(OrderState.Done)
      .persist({ snapshotSchedule: Schedule.forever, journalEvents: true });

  it.scopedLive("spawn persistent actor and process events", () =>
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.scopedLive("version increments on each event", () =>
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("restore actor from persistence", () =>
    Effect.gen(function* () {
      // Use a shared adapter for cross-scope persistence
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore in a new scope
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.scopedLive("restore returns None for non-existent actor", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const persistentMachine = createPersistentMachine();

      const maybeActor = yield* system.restore("non-existent", persistentMachine);
      expect(Option.isNone(maybeActor)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("persist method forces immediate snapshot", () =>
    Effect.gen(function* () {
      // Use a shared adapter for cross-scope persistence
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;

          // Create machine with no automatic snapshots (never trigger schedule)
          const noAutoSnapshotMachine = Machine.make({
            state: OrderState,
            event: OrderEvent,
            initial: OrderState.Idle,
          })
            .on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
              OrderState.Pending({ orderId: event.orderId }),
            )
            .on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
              OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
            )
            .persist({
              snapshotSchedule: Schedule.stop,
              journalEvents: true,
            });

          const actor = yield* system.spawn("order-4", noAutoSnapshotMachine) as Effect.Effect<
            PersistentActorRef<OrderState, OrderEvent>
          >;

          yield* actor.send(OrderEvent.Submit({ orderId: "ORD-PERSIST" }));
          yield* yieldFibers;

          // Force snapshot
          yield* actor.persist;

          // Stop and restore
          yield* system.stop("order-4");
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Verify snapshot was saved
      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const persistentMachine = createPersistentMachine();

          const maybeActor = yield* system.restore("order-4", persistentMachine);
          expect(Option.isSome(maybeActor)).toBe(true);

          if (Option.isSome(maybeActor)) {
            const state = yield* maybeActor.value.snapshot;
            expect(state._tag).toBe("Pending");
          }
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("event journaling for replay", () =>
    Effect.gen(function* () {
      // Use a shared adapter for cross-scope persistence
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;

          // Create machine that snapshots infrequently (only manually)
          const infrequentSnapshotMachine = Machine.make({
            state: OrderState,
            event: OrderEvent,
            initial: OrderState.Idle,
          })
            .on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
              OrderState.Pending({ orderId: event.orderId }),
            )
            .on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
              OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
            )
            .persist({
              snapshotSchedule: Schedule.stop,
              journalEvents: true,
            });

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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore should replay events from journal
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("spawn auto-restores from existing persistence", () =>
    Effect.gen(function* () {
      // Use a shared adapter for cross-scope persistence
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      // First, create and persist an actor
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Spawn again - should auto-restore
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.scopedLive("PersistentActorRef has all ActorRef methods", () =>
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
    }).pipe(Effect.provide(TestLayer)),
  );

  it.scopedLive("final state stops actor properly", () =>
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
      yield* actor.send(OrderEvent.Complete);
      yield* yieldFibers;

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Done");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe("Persistence Registry", () => {
  const createPersistentMachine = (
    machineType?: string,
  ): PersistentMachine<OrderState, OrderEvent> =>
    Machine.make({
      state: OrderState,
      event: OrderEvent,
      initial: OrderState.Idle,
    })
      .on(OrderState.Idle, OrderEvent.Submit, ({ event }) =>
        OrderState.Pending({ orderId: event.orderId }),
      )
      .on(OrderState.Pending, OrderEvent.Pay, ({ state, event }) =>
        OrderState.Paid({ orderId: state.orderId, amount: event.amount }),
      )
      .on(OrderState.Paid, OrderEvent.Complete, () => OrderState.Done)
      .final(OrderState.Done)
      .persist({
        snapshotSchedule: Schedule.forever,
        journalEvents: true,
        machineType,
      });

  it.scopedLive("listPersisted returns empty for no actors", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actors = yield* system.listPersisted();
      expect(actors).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("listPersisted shows spawned actors with metadata", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("restoreMany restores multiple actors", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      // First spawn some actors
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore in new scope
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("restoreMany reports failures for non-existent actors", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      // Spawn one actor
      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const persistentMachine = createPersistentMachine("orders");

          const actor = yield* system.spawn("order-exists", persistentMachine);
          yield* actor.send(OrderEvent.Submit({ orderId: "ORD-X" }));
          yield* yieldFibers;
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Try to restore one that exists and one that doesn't
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("restoreAll restores actors by machineType", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      // Spawn actors of different types
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore only orders
      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const orderMachine = createPersistentMachine("orders");

          const result = yield* system.restoreAll(orderMachine);

          expect(result.restored.length).toBe(2);
          expect(result.failed.length).toBe(0);
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("restoreAll filters by stateTag", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      // Spawn actors in different states
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore only Pending orders
      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("metadata tracks stateTag changes", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
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
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.scopedLive("listPersisted gracefully degrades without registry support", () =>
    Effect.gen(function* () {
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

      yield* Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actors = yield* system.listPersisted();
        expect(actors).toEqual([]);
      }).pipe(Effect.provide(minimalLayer));
    }),
  );

  it.live("restoreAll fails when machineType is undefined", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          // Machine without explicit machineType
          const noTypeMachine = createPersistentMachine(undefined);

          const result = yield* Effect.either(system.restoreAll(noTypeMachine));

          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("PersistenceError");
            expect(result.left.message).toContain("machineType");
          }
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );

  it.live("restored actor preserves original createdAt from metadata", () =>
    Effect.gen(function* () {
      const sharedAdapter = yield* makeInMemoryPersistenceAdapter;
      const sharedLayer = Layer.merge(
        ActorSystemDefault,
        Layer.succeed(PersistenceAdapterTag, sharedAdapter),
      );

      let originalCreatedAt: number | undefined;

      // Spawn actor and record its createdAt
      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const persistentMachine = createPersistentMachine("orders");

          const actor = yield* system.spawn("order-created-at", persistentMachine);
          yield* actor.send(OrderEvent.Submit({ orderId: "C1" }));
          yield* yieldFibers;

          // Get the metadata to check createdAt
          const actors = yield* system.listPersisted();
          const meta = actors.find((a) => a.id === "order-created-at");
          expect(meta).toBeDefined();
          originalCreatedAt = meta!.createdAt;

          // Wait a bit to ensure time passes
          yield* Effect.sleep("10 millis");

          // Send another event to update lastActivityAt but not createdAt
          yield* actor.send(OrderEvent.Pay({ amount: 100 }));
          yield* yieldFibers;
        }).pipe(Effect.provide(sharedLayer)),
      );

      // Restore and verify createdAt is preserved
      yield* Effect.scoped(
        Effect.gen(function* () {
          const system = yield* ActorSystemService;
          const persistentMachine = createPersistentMachine("orders");

          const maybeActor = yield* system.restore("order-created-at", persistentMachine);
          expect(Option.isSome(maybeActor)).toBe(true);

          // Check metadata after restore
          const actors = yield* system.listPersisted();
          const meta = actors.find((a) => a.id === "order-created-at");
          expect(meta).toBeDefined();
          expect(originalCreatedAt).toBeDefined();
          expect(meta!.createdAt).toBe(originalCreatedAt!);
          // lastActivityAt should be updated
          expect(meta!.lastActivityAt).toBeGreaterThanOrEqual(meta!.createdAt);
        }).pipe(Effect.provide(sharedLayer)),
      );
    }),
  );
});
