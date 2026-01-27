// @effect-diagnostics strictEffectProvide:off - tests are entry points
/**
 * State/Event Schema Tests
 *
 * Verifies schema-first State/Event definitions work correctly:
 * - Schema validation/encoding/decoding
 * - Variant constructors
 * - Pattern matching ($is, $match)
 * - Integration with Machine
 */
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Machine, State, Event, simulate } from "../src/index.js";

describe("State (schema-first)", () => {
  test("creates variant constructors", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    const pending = OrderState.Pending({ orderId: "order-123" });
    expect(pending._tag).toBe("Pending");
    expect(pending.orderId).toBe("order-123");

    const shipped = OrderState.Shipped({ trackingId: "track-456" });
    expect(shipped._tag).toBe("Shipped");
    expect(shipped.trackingId).toBe("track-456");
  });

  test("$is type guard works", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    const pending = OrderState.Pending({ orderId: "123" });
    const shipped = OrderState.Shipped({ trackingId: "456" });

    expect(OrderState.$is("Pending")(pending)).toBe(true);
    expect(OrderState.$is("Shipped")(pending)).toBe(false);
    expect(OrderState.$is("Pending")(shipped)).toBe(false);
    expect(OrderState.$is("Shipped")(shipped)).toBe(true);

    // Invalid values
    expect(OrderState.$is("Pending")(null)).toBe(false);
    expect(OrderState.$is("Pending")(undefined)).toBe(false);
    expect(OrderState.$is("Pending")({ _tag: "Other" })).toBe(false);
  });

  test("$match works (uncurried)", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    const pending = OrderState.Pending({ orderId: "123" });
    const shipped = OrderState.Shipped({ trackingId: "456" });

    const pendingResult = OrderState.$match(pending, {
      Pending: (s) => `Order ${s.orderId} pending`,
      Shipped: (s) => `Shipped: ${s.trackingId}`,
    });
    expect(pendingResult).toBe("Order 123 pending");

    const shippedResult = OrderState.$match(shipped, {
      Pending: (s) => `Order ${s.orderId} pending`,
      Shipped: (s) => `Shipped: ${s.trackingId}`,
    });
    expect(shippedResult).toBe("Shipped: 456");
  });

  test("$match works (curried)", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    const matcher = OrderState.$match({
      Pending: (s) => `pending:${s.orderId}`,
      Shipped: (s) => `shipped:${s.trackingId}`,
    });

    expect(matcher(OrderState.Pending({ orderId: "a" }))).toBe("pending:a");
    expect(matcher(OrderState.Shipped({ trackingId: "b" }))).toBe("shipped:b");
  });

  test("works as Schema for decode", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    // Decode valid data
    const decoded = Schema.decodeUnknownSync(OrderState)({
      _tag: "Pending",
      orderId: "test-order",
    });
    expect(decoded._tag).toBe("Pending");
    expect((decoded as { orderId: string }).orderId).toBe("test-order");

    // Decode another variant
    const decoded2 = Schema.decodeUnknownSync(OrderState)({
      _tag: "Shipped",
      trackingId: "abc",
    });
    expect(decoded2._tag).toBe("Shipped");
  });

  test("works as Schema for encode", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    const pending = OrderState.Pending({ orderId: "123" });
    const encoded = Schema.encodeSync(OrderState)(pending);

    expect(encoded).toEqual({ _tag: "Pending", orderId: "123" });
  });

  test("validation rejects invalid data", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    // Invalid _tag
    expect(() => Schema.decodeUnknownSync(OrderState)({ _tag: "Invalid" })).toThrow();

    // Missing required field
    expect(() => Schema.decodeUnknownSync(OrderState)({ _tag: "Pending" })).toThrow();

    // Wrong field type
    expect(() => Schema.decodeUnknownSync(OrderState)({ _tag: "Pending", orderId: 123 })).toThrow();
  });

  test("variants property provides per-variant schemas", () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Shipped: { trackingId: Schema.String },
    });

    // Access individual variant schemas
    expect(OrderState.variants.Pending).toBeDefined();
    expect(OrderState.variants.Shipped).toBeDefined();

    // Can decode individual variant
    const pending = Schema.decodeUnknownSync(OrderState.variants.Pending)({
      _tag: "Pending",
      orderId: "test",
    });
    expect(pending.orderId).toBe("test");
  });

  test("handles empty fields variant", () => {
    const ToggleState = State({
      On: {},
      Off: {},
    });

    // Empty variants are values, not constructors
    const on = ToggleState.On;
    expect(on._tag).toBe("On");

    const off = ToggleState.Off;
    expect(off._tag).toBe("Off");
  });
});

describe("Event (schema-first)", () => {
  test("creates event constructors", () => {
    const OrderEvent = Event({
      Ship: { trackingId: Schema.String },
      Cancel: { reason: Schema.String },
    });

    const ship = OrderEvent.Ship({ trackingId: "track-123" });
    expect(ship._tag).toBe("Ship");
    expect(ship.trackingId).toBe("track-123");
  });

  test("$is and $match work for events", () => {
    const OrderEvent = Event({
      Ship: { trackingId: Schema.String },
      Cancel: { reason: Schema.String },
    });

    const ship = OrderEvent.Ship({ trackingId: "abc" });

    expect(OrderEvent.$is("Ship")(ship)).toBe(true);
    expect(OrderEvent.$is("Cancel")(ship)).toBe(false);

    const result = OrderEvent.$match(ship, {
      Ship: (e) => `Shipping: ${e.trackingId}`,
      Cancel: (e) => `Cancelled: ${e.reason}`,
    });
    expect(result).toBe("Shipping: abc");
  });
});

describe("State/Event with Machine", () => {
  test("schema-first types work with Machine.make", async () => {
    const OrderState = State({
      Pending: { orderId: Schema.String },
      Processing: { orderId: Schema.String },
      Shipped: { orderId: Schema.String, trackingId: Schema.String },
    });
    type OrderState = typeof OrderState.Type;

    const OrderEvent = Event({
      Process: {},
      Ship: { trackingId: Schema.String },
    });
    type OrderEvent = typeof OrderEvent.Type;

    // Machine uses schema-created values
    const machine = Machine.make({
      state: OrderState,
      event: OrderEvent,
      initial: OrderState.Pending({ orderId: "test-order" }),
    }).pipe(
      Machine.on(OrderState.Pending, OrderEvent.Process, ({ state }) =>
        OrderState.Processing({ orderId: state.orderId }),
      ),
      Machine.on(OrderState.Processing, OrderEvent.Ship, ({ state, event }) =>
        OrderState.Shipped({ orderId: state.orderId, trackingId: event.trackingId }),
      ),
      Machine.final(OrderState.Shipped),
    );

    const result = await Effect.runPromise(
      simulate(machine, [OrderEvent.Process, OrderEvent.Ship({ trackingId: "TRACK-123" })]),
    );

    expect(result.finalState._tag).toBe("Shipped");
    expect((result.finalState as { trackingId: string }).trackingId).toBe("TRACK-123");
  });

  test("state constructors are compatible with Machine.on", () => {
    const TestState = State({
      A: { value: Schema.Number },
      B: { value: Schema.Number },
    });
    type TestState = typeof TestState.Type;

    const TestEvent = Event({
      Next: {},
    });
    type TestEvent = typeof TestEvent.Type;

    // This should compile - state constructors produce branded types
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.A({ value: 0 }),
    }).pipe(
      Machine.on(TestState.A, TestEvent.Next, ({ state }) =>
        TestState.B({ value: state.value + 1 }),
      ),
    );

    expect(machine.transitions.length).toBe(1);
  });
});
