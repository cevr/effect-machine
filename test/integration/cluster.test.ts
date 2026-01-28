// @effect-diagnostics strictEffectProvide:off - tests are entry points
/**
 * Cluster Integration Tests
 *
 * Tests the integration between effect-machine and @effect/cluster using:
 * - MachineSchema for schema-first definitions (single source of truth)
 * - toEntity for generating Entity definitions
 * - EntityMachine.layer for wiring machine to cluster
 */
import { Entity, ShardingConfig } from "@effect/cluster";
import { Rpc } from "@effect/rpc";
import { Effect, Ref, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Guard, Machine, simulate, State, Event } from "../../src/index.js";
import { toEntity } from "../../src/cluster/index.js";

// Type for guard predicate (sync or async)
type GuardPredicateFn<S, E> = (ctx: { state: S; event: E }) => boolean | Effect.Effect<boolean>;

// Helper to evaluate guard trees for manual Entity testing
const evaluateGuardManual = <S, E>(
  guardHandlers: ReadonlyMap<string, GuardPredicateFn<S, E>>,
  guard: ReturnType<typeof Guard.make>,
  ctx: { state: S; event: E },
): boolean | Effect.Effect<boolean, never, never> => {
  switch (guard._tag) {
    case "GuardSlot": {
      const predicate = guardHandlers.get(guard.name);
      if (predicate === undefined) {
        throw new Error(`Guard not provided: ${guard.name}`);
      }
      return predicate(ctx);
    }
    case "GuardAnd": {
      const results = guard.guards.map((g) => evaluateGuardManual(guardHandlers, g, ctx));
      if (results.some((r) => Effect.isEffect(r))) {
        return Effect.all(results.map((r) => (Effect.isEffect(r) ? r : Effect.succeed(r)))).pipe(
          Effect.map((rs) => rs.every(Boolean)),
        );
      }
      return (results as boolean[]).every(Boolean);
    }
    case "GuardOr": {
      const results = guard.guards.map((g) => evaluateGuardManual(guardHandlers, g, ctx));
      if (results.some((r) => Effect.isEffect(r))) {
        return Effect.all(results.map((r) => (Effect.isEffect(r) ? r : Effect.succeed(r)))).pipe(
          Effect.map((rs) => rs.some(Boolean)),
        );
      }
      return (results as boolean[]).some(Boolean);
    }
    case "GuardNot": {
      const result = evaluateGuardManual(guardHandlers, guard.guard, ctx);
      if (Effect.isEffect(result)) {
        return Effect.map(result, (r) => !r);
      }
      return !result;
    }
  }
};

// =============================================================================
// Schema-first definitions using MachineSchema
// =============================================================================

// State and Event defined once - schema IS the source of truth
const OrderState = State({
  Pending: { orderId: Schema.String },
  Processing: { orderId: Schema.String, startedAt: Schema.Number },
  Shipped: { orderId: Schema.String, trackingId: Schema.String },
  Cancelled: { orderId: Schema.String, reason: Schema.String },
});
type OrderState = typeof OrderState.Type;

const OrderEvent = Event({
  Process: {},
  Ship: { trackingId: Schema.String },
  Cancel: { reason: Schema.String },
});
type OrderEvent = typeof OrderEvent.Type;

// =============================================================================
// Machine definition (same pattern as before)
// =============================================================================

const orderMachine = Machine.make({
  state: OrderState,
  event: OrderEvent,
  initial: OrderState.Pending({ orderId: "" }),
})
  .on(OrderState.Pending, OrderEvent.Process, ({ state }) =>
    OrderState.Processing({ orderId: state.orderId, startedAt: Date.now() }),
  )
  .on(OrderState.Processing, OrderEvent.Ship, ({ state, event }) =>
    OrderState.Shipped({ orderId: state.orderId, trackingId: event.trackingId }),
  )
  .on(OrderState.Pending, OrderEvent.Cancel, ({ state, event }) =>
    OrderState.Cancelled({ orderId: state.orderId, reason: event.reason }),
  )
  .on(OrderState.Processing, OrderEvent.Cancel, ({ state, event }) =>
    OrderState.Cancelled({ orderId: state.orderId, reason: event.reason }),
  )
  .final(OrderState.Shipped)
  .final(OrderState.Cancelled);

// =============================================================================
// Entity definition using toEntity helper
// =============================================================================

// Schemas are attached to machine - no need to pass them!
const OrderEntity = toEntity(orderMachine, { type: "Order" });

// =============================================================================
// Sharding config for tests
// =============================================================================

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
});

// =============================================================================
// Tests
// =============================================================================

describe("Cluster Integration with MachineSchema", () => {
  test("MachineSchema types work with simulate() (baseline)", async () => {
    // simulate() works great for testing pure state machine logic
    await Effect.runPromise(
      Effect.gen(function* () {
        const machineWithInitial = Machine.make({
          state: OrderState,
          event: OrderEvent,
          initial: OrderState.Pending({ orderId: "order-123" }),
        })
          .on(OrderState.Pending, OrderEvent.Process, ({ state }) =>
            OrderState.Processing({ orderId: state.orderId, startedAt: 1000 }),
          )
          .on(OrderState.Processing, OrderEvent.Ship, ({ state, event }) =>
            OrderState.Shipped({ orderId: state.orderId, trackingId: event.trackingId }),
          )
          .final(OrderState.Shipped);

        const result = yield* simulate(machineWithInitial, [
          OrderEvent.Process,
          OrderEvent.Ship({ trackingId: "TRACK-456" }),
        ]);

        expect(result.finalState._tag).toBe("Shipped");
        expect((result.finalState as { trackingId: string }).trackingId).toBe("TRACK-456");
        expect(result.states.map((s) => s._tag)).toEqual(["Pending", "Processing", "Shipped"]);
      }),
    );
  });

  test("toEntity generates correct Entity definition", () => {
    // toEntity creates an Entity with Send and GetState RPCs
    // OrderEntity.type is branded, so cast to string for comparison
    expect(OrderEntity.type as string).toBe("Order");
    expect(OrderEntity.protocol).toBeDefined();
  });

  test("MachineSchema $match works for pattern matching", () => {
    const state = OrderState.Pending({ orderId: "test-123" });

    const message = OrderState.$match(state, {
      Pending: (s) => `Order ${s.orderId} is pending`,
      Processing: (s) => `Order ${s.orderId} started at ${s.startedAt}`,
      Shipped: (s) => `Order ${s.orderId} shipped: ${s.trackingId}`,
      Cancelled: (s) => `Order ${s.orderId} cancelled: ${s.reason}`,
    });

    expect(message).toBe("Order test-123 is pending");
  });

  test("MachineSchema $is works for type guards", () => {
    const pending = OrderState.Pending({ orderId: "123" });
    const shipped = OrderState.Shipped({ orderId: "123", trackingId: "abc" });

    expect(OrderState.$is("Pending")(pending)).toBe(true);
    expect(OrderState.$is("Shipped")(pending)).toBe(false);
    expect(OrderState.$is("Shipped")(shipped)).toBe(true);
  });

  test("MachineSchema works as Schema for encode/decode", () => {
    const pending = OrderState.Pending({ orderId: "test" });

    // Encode
    const encoded = Schema.encodeSync(OrderState)(pending);
    expect(encoded).toEqual({ _tag: "Pending", orderId: "test" });

    // Decode
    const decoded = Schema.decodeUnknownSync(OrderState)({
      _tag: "Shipped",
      orderId: "123",
      trackingId: "abc",
    });
    expect(decoded._tag).toBe("Shipped");
  });

  test("Machine.findTransitions provides O(1) lookup", () => {
    // Using the indexed lookup
    const transitions = Machine.findTransitions(orderMachine, "Pending", "Process");
    expect(transitions.length).toBe(1);
    expect(transitions[0]?.stateTag).toBe("Pending");
    expect(transitions[0]?.eventTag).toBe("Process");

    // No transition for this pair
    const noMatch = Machine.findTransitions(orderMachine, "Shipped", "Process");
    expect(noMatch.length).toBe(0);
  });
});

// =============================================================================
// Integration tests with Entity.makeTestClient
// =============================================================================

describe("Entity.makeTestClient with machine handler", () => {
  // Counter machine for guard testing
  const CounterState = State({
    Counting: { count: Schema.Number },
    Done: { count: Schema.Number },
  });
  type CounterState = typeof CounterState.Type;

  const CounterEvent = Event({
    Increment: {},
    Finish: {},
  });
  type CounterEvent = typeof CounterEvent.Type;

  const counterMachine = Machine.make({
    state: CounterState,
    event: CounterEvent,
    initial: CounterState.Counting({ count: 0 }),
  })
    .on(
      CounterState.Counting,
      CounterEvent.Increment,
      ({ state }) => CounterState.Counting({ count: state.count + 1 }),
      { guard: Guard.make("underLimit") },
    )
    .on(CounterState.Counting, CounterEvent.Finish, ({ state }) =>
      CounterState.Done({ count: state.count }),
    )
    .provide({
      underLimit: ({ state }: { state: { count: number } }) => state.count < 3,
    })
    .final(CounterState.Done);

  // Entity using MachineSchema directly as schemas
  const CounterEntity = Entity.make("Counter", [
    Rpc.make("Send", { payload: { event: CounterEvent }, success: CounterState }),
    Rpc.make("GetState", { success: CounterState }),
  ]);

  // Entity using MachineSchema for Order as well
  const OrderEntityManual = Entity.make("OrderManual", [
    Rpc.make("Send", { payload: { event: OrderEvent }, success: OrderState }),
    Rpc.make("GetState", { success: OrderState }),
  ]);

  test("Entity.makeTestClient works with MachineSchema", async () => {
    const OrderEntityWithMachine = OrderEntityManual.toLayer(
      Effect.gen(function* () {
        const stateRef = yield* Ref.make<OrderState>(
          OrderState.Pending({ orderId: "will-be-set" }),
        );

        return OrderEntityManual.of({
          Send: (envelope) =>
            Effect.gen(function* () {
              const currentState = yield* Ref.get(stateRef);
              const event = envelope.payload.event as unknown as OrderEvent;

              const transitions = Machine.findTransitions(
                orderMachine,
                currentState._tag,
                event._tag,
              );

              let transition: (typeof transitions)[number] | undefined;
              for (const t of transitions) {
                if (t.guard === undefined) {
                  transition = t;
                  break;
                }
                const guardResult = evaluateGuardManual(orderMachine.guardHandlers, t.guard, {
                  state: currentState,
                  event,
                });
                const ok = Effect.isEffect(guardResult) ? yield* guardResult : guardResult;
                if (ok) {
                  transition = t;
                  break;
                }
              }

              if (transition === undefined) {
                return currentState;
              }

              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
              const newState = transition.handler({ state: currentState, event } as any);
              yield* Ref.set(stateRef, newState as OrderState);
              return newState as OrderState;
            }),

          GetState: () => Ref.get(stateRef),
        });
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const makeClient = yield* Entity.makeTestClient(OrderEntityManual, OrderEntityWithMachine);
        const client = yield* makeClient("order-123");

        const initialState = yield* client.GetState();
        expect(initialState._tag).toBe("Pending");

        const processingState = yield* client.Send({ event: OrderEvent.Process });
        expect(processingState._tag).toBe("Processing");

        const shippedState = yield* client.Send({
          event: OrderEvent.Ship({ trackingId: "TRACK-789" }),
        });
        expect(shippedState._tag).toBe("Shipped");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion
        expect((shippedState as any).trackingId).toBe("TRACK-789");
      }).pipe(Effect.scoped, Effect.provide(TestShardingConfig)),
    );
  });

  test("guards work with Machine.findTransitions", async () => {
    const CounterEntityLayer = CounterEntity.toLayer(
      Effect.gen(function* () {
        const stateRef = yield* Ref.make<CounterState>(CounterState.Counting({ count: 0 }));

        return CounterEntity.of({
          Send: (envelope) =>
            Effect.gen(function* () {
              const currentState = yield* Ref.get(stateRef);
              const event = envelope.payload.event as unknown as CounterEvent;

              const transitions = Machine.findTransitions(
                counterMachine,
                currentState._tag,
                event._tag,
              );

              let transition: (typeof transitions)[number] | undefined;
              for (const t of transitions) {
                if (t.guard === undefined) {
                  transition = t;
                  break;
                }
                const guardResult = evaluateGuardManual(counterMachine.guardHandlers, t.guard, {
                  state: currentState,
                  event,
                });
                const ok = Effect.isEffect(guardResult) ? yield* guardResult : guardResult;
                if (ok) {
                  transition = t;
                  break;
                }
              }

              if (transition === undefined) {
                return currentState;
              }

              // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper
              const newState = transition.handler({ state: currentState, event } as any);
              yield* Ref.set(stateRef, newState as CounterState);
              return newState as CounterState;
            }),
          GetState: () => Ref.get(stateRef),
        });
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const makeClient = yield* Entity.makeTestClient(CounterEntity, CounterEntityLayer);
        const client = yield* makeClient("counter-1");

        // Increment 4 times - only 3 should work due to guard
        yield* client.Send({ event: CounterEvent.Increment });
        yield* client.Send({ event: CounterEvent.Increment });
        yield* client.Send({ event: CounterEvent.Increment });
        yield* client.Send({ event: CounterEvent.Increment }); // blocked by guard

        const state = yield* client.GetState();
        expect(state._tag).toBe("Counting");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test assertion
        expect((state as any).count).toBe(3);
      }).pipe(Effect.scoped, Effect.provide(TestShardingConfig)),
    );
  });
});

// =============================================================================
// Summary
// =============================================================================
/**
 * ## MachineSchema - Single Source of Truth
 *
 * - Define state/event once with `State({...})` / `Event({...})`
 * - Get Schema + constructors + pattern matching in one definition
 * - No more duplication between State<T> and Schema definitions
 * - Works seamlessly with Machine.make, persistence, and cluster
 *
 * ## Key APIs
 *
 * - `State({...})` / `Event({...})` - schema-first definitions
 * - `typeof X.Type` - infer TypeScript type from schema
 * - `X.$is("Tag")` - type guard
 * - `X.$match(value, cases)` - pattern matching
 * - `Schema.encodeSync(X)` / `Schema.decodeUnknownSync(X)` - serialization
 *
 * ## Migration
 *
 * Old:
 * ```ts
 * type MyState = State<{ Idle: {}; Active: { count: number } }>;
 * const MyState = State<MyState>();
 * ```
 *
 * New:
 * ```ts
 * const MyState = State({ Idle: {}, Active: { count: Schema.Number } });
 * type MyState = typeof MyState.Type;
 * ```
 */
