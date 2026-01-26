// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  assertNeverReaches,
  assertPath,
  Guard,
  Machine,
  yieldFibers,
} from "../../src/index.js";

/**
 * Payment flow pattern tests based on bite checkout-paying.machine.ts
 * Tests: retry after error, bridge vs API routing, mid-flow cancellation
 */
describe("Payment Flow Pattern", () => {
  type PaymentMethod = "card" | "bridge" | "cash";

  type PaymentState = Data.TaggedEnum<{
    Idle: {};
    SelectingMethod: { amount: number };
    ProcessingPayment: { method: PaymentMethod; amount: number; attempts: number };
    AwaitingBridgeConfirm: { transactionId: string };
    PaymentError: { error: string; canRetry: boolean; attempts: number; amount: number };
    PaymentSuccess: { receiptId: string };
    PaymentCancelled: {};
  }>;
  const State = Data.taggedEnum<PaymentState>();

  type PaymentEvent = Data.TaggedEnum<{
    StartCheckout: { amount: number };
    SelectMethod: { method: PaymentMethod };
    PaymentSucceeded: { receiptId: string };
    PaymentFailed: { error: string; canRetry: boolean };
    BridgeConfirmed: { transactionId: string };
    BridgeTimeout: {};
    Retry: {};
    Cancel: {};
    AutoDismissError: {};
  }>;
  const Event = Data.taggedEnum<PaymentEvent>();

  // Type aliases for guards
  type SelectingMethodState = PaymentState & { _tag: "SelectingMethod" };
  type SelectMethodEvent = PaymentEvent & { _tag: "SelectMethod" };
  type PaymentErrorState = PaymentState & { _tag: "PaymentError" };
  type RetryEvent = PaymentEvent & { _tag: "Retry" };

  // Guards
  const isBridgePayment = Guard.make<SelectingMethodState, SelectMethodEvent>(
    ({ event }) => event.method === "bridge",
  );
  const canRetry = Guard.make<PaymentErrorState, RetryEvent>(
    ({ state }) => state.canRetry && state.attempts < 3,
  );

  const paymentMachine = Machine.build(
    Machine.make<PaymentState, PaymentEvent>(State.Idle()).pipe(
      // Start checkout
      Machine.on(State.Idle, Event.StartCheckout, ({ event }) =>
        State.SelectingMethod({ amount: event.amount }),
      ),

      // Method selection - guard cascade for bridge vs regular
      Machine.from(State.SelectingMethod).pipe(
        Machine.on(
          Event.SelectMethod,
          ({ state, event }) =>
            State.ProcessingPayment({ method: event.method, amount: state.amount, attempts: 1 }),
          { guard: Guard.not(isBridgePayment) },
        ),
        Machine.on(
          Event.SelectMethod,
          () => State.AwaitingBridgeConfirm({ transactionId: `bridge-${Date.now()}` }),
          { guard: isBridgePayment },
        ),
      ),

      // Bridge confirmation
      Machine.from(State.AwaitingBridgeConfirm).pipe(
        Machine.on(Event.BridgeConfirmed, ({ event }) =>
          State.PaymentSuccess({ receiptId: event.transactionId }),
        ),
        Machine.on(Event.BridgeTimeout, () =>
          State.PaymentError({ error: "Bridge timeout", canRetry: true, attempts: 1, amount: 100 }),
        ),
      ),
      Machine.delay(State.AwaitingBridgeConfirm, "30 seconds", Event.BridgeTimeout()),

      // Processing results
      Machine.from(State.ProcessingPayment).pipe(
        Machine.on(Event.PaymentSucceeded, ({ event }) =>
          State.PaymentSuccess({ receiptId: event.receiptId }),
        ),
        Machine.on(Event.PaymentFailed, ({ state, event }) =>
          State.PaymentError({
            error: event.error,
            canRetry: event.canRetry,
            attempts: state.attempts,
            amount: state.amount,
          }),
        ),
      ),

      // Error state handlers
      Machine.from(State.PaymentError).pipe(
        // Retry with guard
        Machine.on(
          Event.Retry,
          ({ state }) =>
            State.ProcessingPayment({
              method: "card",
              amount: state.amount,
              attempts: state.attempts + 1,
            }),
          { guard: canRetry },
        ),
        Machine.on(Event.AutoDismissError, () => State.Idle()),
      ),

      // Auto-dismiss non-retryable errors
      Machine.delay(State.PaymentError, "5 seconds", Event.AutoDismissError(), {
        guard: (state) => !state.canRetry,
      }),

      // Cancellation from any processing state using Machine.any
      Machine.on(
        Machine.any(
          State.SelectingMethod,
          State.ProcessingPayment,
          State.AwaitingBridgeConfirm,
          State.PaymentError,
        ),
        Event.Cancel,
        () => State.PaymentCancelled(),
      ),

      Machine.final(State.PaymentSuccess),
      Machine.final(State.PaymentCancelled),
    ),
  );

  test("card payment happy path", async () => {
    await Effect.runPromise(
      assertPath(
        paymentMachine,
        [
          Event.StartCheckout({ amount: 100 }),
          Event.SelectMethod({ method: "card" }),
          Event.PaymentSucceeded({ receiptId: "rcpt-123" }),
        ],
        ["Idle", "SelectingMethod", "ProcessingPayment", "PaymentSuccess"],
      ),
    );
  });

  test("bridge payment flow", async () => {
    await Effect.runPromise(
      assertPath(
        paymentMachine,
        [
          Event.StartCheckout({ amount: 200 }),
          Event.SelectMethod({ method: "bridge" }),
          Event.BridgeConfirmed({ transactionId: "tx-456" }),
        ],
        ["Idle", "SelectingMethod", "AwaitingBridgeConfirm", "PaymentSuccess"],
      ),
    );
  });

  test("retry after error with guard cascade", async () => {
    await Effect.runPromise(
      assertPath(
        paymentMachine,
        [
          Event.StartCheckout({ amount: 50 }),
          Event.SelectMethod({ method: "card" }),
          Event.PaymentFailed({ error: "Network error", canRetry: true }),
          Event.Retry(),
          Event.PaymentSucceeded({ receiptId: "rcpt-retry" }),
        ],
        [
          "Idle",
          "SelectingMethod",
          "ProcessingPayment",
          "PaymentError",
          "ProcessingPayment",
          "PaymentSuccess",
        ],
      ),
    );
  });

  test("retry blocked after max attempts", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("payment", paymentMachine);

        yield* actor.send(Event.StartCheckout({ amount: 50 }));
        yield* actor.send(Event.SelectMethod({ method: "card" }));

        // Fail and retry twice (total 3 attempts)
        yield* actor.send(Event.PaymentFailed({ error: "Error 1", canRetry: true }));
        yield* yieldFibers;
        yield* actor.send(Event.Retry());
        yield* yieldFibers;
        yield* actor.send(Event.PaymentFailed({ error: "Error 2", canRetry: true }));
        yield* yieldFibers;
        yield* actor.send(Event.Retry());
        yield* yieldFibers;
        yield* actor.send(Event.PaymentFailed({ error: "Error 3", canRetry: true }));
        yield* yieldFibers;

        // Third retry should be blocked (attempts = 3, guard requires < 3)
        yield* actor.send(Event.Retry());
        yield* yieldFibers;

        const state = yield* actor.state.get;
        expect(state._tag).toBe("PaymentError");
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("mid-flow cancellation", async () => {
    await Effect.runPromise(
      assertPath(
        paymentMachine,
        [
          Event.StartCheckout({ amount: 100 }),
          Event.SelectMethod({ method: "card" }),
          Event.Cancel(),
        ],
        ["Idle", "SelectingMethod", "ProcessingPayment", "PaymentCancelled"],
      ),
    );
  });

  test("cancellation never reaches success", async () => {
    await Effect.runPromise(
      assertNeverReaches(
        paymentMachine,
        [Event.StartCheckout({ amount: 100 }), Event.Cancel()],
        "PaymentSuccess",
      ),
    );
  });

  test("bridge timeout triggers error", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("payment", paymentMachine);

        yield* actor.send(Event.StartCheckout({ amount: 100 }));
        yield* actor.send(Event.SelectMethod({ method: "bridge" }));
        yield* yieldFibers;

        let state = yield* actor.state.get;
        expect(state._tag).toBe("AwaitingBridgeConfirm");

        // Advance past timeout
        yield* TestClock.adjust("30 seconds");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("PaymentError");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("non-retryable error auto-dismisses", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("payment", paymentMachine);

        yield* actor.send(Event.StartCheckout({ amount: 100 }));
        yield* actor.send(Event.SelectMethod({ method: "card" }));
        yield* actor.send(Event.PaymentFailed({ error: "Card declined", canRetry: false }));
        yield* yieldFibers;

        let state = yield* actor.state.get;
        expect(state._tag).toBe("PaymentError");

        // Wait for auto-dismiss
        yield* TestClock.adjust("5 seconds");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("Idle");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });
});
