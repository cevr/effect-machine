// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  assertNeverReaches,
  assertPath,
  Event,
  Guard,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

/**
 * Payment flow pattern tests based on bite checkout-paying.machine.ts
 * Tests: retry after error, bridge vs API routing, mid-flow cancellation
 */
describe("Payment Flow Pattern", () => {
  type PaymentMethod = "card" | "bridge" | "cash";

  type PaymentState = State<{
    Idle: {};
    SelectingMethod: { amount: number };
    ProcessingPayment: { method: PaymentMethod; amount: number; attempts: number };
    AwaitingBridgeConfirm: { transactionId: string };
    PaymentError: { error: string; canRetry: boolean; attempts: number; amount: number };
    PaymentSuccess: { receiptId: string };
    PaymentCancelled: {};
  }>;
  const PaymentState = State<PaymentState>();

  type PaymentEvent = Event<{
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
  const PaymentEvent = Event<PaymentEvent>();

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
    Machine.make<PaymentState, PaymentEvent>(PaymentState.Idle()).pipe(
      // Start checkout
      Machine.on(PaymentState.Idle, PaymentEvent.StartCheckout, ({ event }) =>
        PaymentState.SelectingMethod({ amount: event.amount }),
      ),

      // Method selection - guard cascade for bridge vs regular
      Machine.from(PaymentState.SelectingMethod).pipe(
        Machine.on(
          PaymentEvent.SelectMethod,
          ({ state, event }) =>
            PaymentState.ProcessingPayment({
              method: event.method,
              amount: state.amount,
              attempts: 1,
            }),
          { guard: Guard.not(isBridgePayment) },
        ),
        Machine.on(
          PaymentEvent.SelectMethod,
          () => PaymentState.AwaitingBridgeConfirm({ transactionId: `bridge-${Date.now()}` }),
          { guard: isBridgePayment },
        ),
      ),

      // Bridge confirmation
      Machine.from(PaymentState.AwaitingBridgeConfirm).pipe(
        Machine.on(PaymentEvent.BridgeConfirmed, ({ event }) =>
          PaymentState.PaymentSuccess({ receiptId: event.transactionId }),
        ),
        Machine.on(PaymentEvent.BridgeTimeout, () =>
          PaymentState.PaymentError({
            error: "Bridge timeout",
            canRetry: true,
            attempts: 1,
            amount: 100,
          }),
        ),
      ),
      Machine.delay(PaymentState.AwaitingBridgeConfirm, "30 seconds", PaymentEvent.BridgeTimeout()),

      // Processing results
      Machine.from(PaymentState.ProcessingPayment).pipe(
        Machine.on(PaymentEvent.PaymentSucceeded, ({ event }) =>
          PaymentState.PaymentSuccess({ receiptId: event.receiptId }),
        ),
        Machine.on(PaymentEvent.PaymentFailed, ({ state, event }) =>
          PaymentState.PaymentError({
            error: event.error,
            canRetry: event.canRetry,
            attempts: state.attempts,
            amount: state.amount,
          }),
        ),
      ),

      // Error state handlers
      Machine.from(PaymentState.PaymentError).pipe(
        // Retry with guard
        Machine.on(
          PaymentEvent.Retry,
          ({ state }) =>
            PaymentState.ProcessingPayment({
              method: "card",
              amount: state.amount,
              attempts: state.attempts + 1,
            }),
          { guard: canRetry },
        ),
        Machine.on(PaymentEvent.AutoDismissError, () => PaymentState.Idle()),
      ),

      // Auto-dismiss non-retryable errors
      Machine.delay(PaymentState.PaymentError, "5 seconds", PaymentEvent.AutoDismissError(), {
        guard: (state) => !state.canRetry,
      }),

      // Cancellation from any processing state using Machine.any
      Machine.on(
        Machine.any(
          PaymentState.SelectingMethod,
          PaymentState.ProcessingPayment,
          PaymentState.AwaitingBridgeConfirm,
          PaymentState.PaymentError,
        ),
        PaymentEvent.Cancel,
        () => PaymentState.PaymentCancelled(),
      ),

      Machine.final(PaymentState.PaymentSuccess),
      Machine.final(PaymentState.PaymentCancelled),
    ),
  );

  test("card payment happy path", async () => {
    await Effect.runPromise(
      assertPath(
        paymentMachine,
        [
          PaymentEvent.StartCheckout({ amount: 100 }),
          PaymentEvent.SelectMethod({ method: "card" }),
          PaymentEvent.PaymentSucceeded({ receiptId: "rcpt-123" }),
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
          PaymentEvent.StartCheckout({ amount: 200 }),
          PaymentEvent.SelectMethod({ method: "bridge" }),
          PaymentEvent.BridgeConfirmed({ transactionId: "tx-456" }),
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
          PaymentEvent.StartCheckout({ amount: 50 }),
          PaymentEvent.SelectMethod({ method: "card" }),
          PaymentEvent.PaymentFailed({ error: "Network error", canRetry: true }),
          PaymentEvent.Retry(),
          PaymentEvent.PaymentSucceeded({ receiptId: "rcpt-retry" }),
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

        yield* actor.send(PaymentEvent.StartCheckout({ amount: 50 }));
        yield* actor.send(PaymentEvent.SelectMethod({ method: "card" }));

        // Fail and retry twice (total 3 attempts)
        yield* actor.send(PaymentEvent.PaymentFailed({ error: "Error 1", canRetry: true }));
        yield* yieldFibers;
        yield* actor.send(PaymentEvent.Retry());
        yield* yieldFibers;
        yield* actor.send(PaymentEvent.PaymentFailed({ error: "Error 2", canRetry: true }));
        yield* yieldFibers;
        yield* actor.send(PaymentEvent.Retry());
        yield* yieldFibers;
        yield* actor.send(PaymentEvent.PaymentFailed({ error: "Error 3", canRetry: true }));
        yield* yieldFibers;

        // Third retry should be blocked (attempts = 3, guard requires < 3)
        yield* actor.send(PaymentEvent.Retry());
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
          PaymentEvent.StartCheckout({ amount: 100 }),
          PaymentEvent.SelectMethod({ method: "card" }),
          PaymentEvent.Cancel(),
        ],
        ["Idle", "SelectingMethod", "ProcessingPayment", "PaymentCancelled"],
      ),
    );
  });

  test("cancellation never reaches success", async () => {
    await Effect.runPromise(
      assertNeverReaches(
        paymentMachine,
        [PaymentEvent.StartCheckout({ amount: 100 }), PaymentEvent.Cancel()],
        "PaymentSuccess",
      ),
    );
  });

  test("bridge timeout triggers error", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("payment", paymentMachine);

        yield* actor.send(PaymentEvent.StartCheckout({ amount: 100 }));
        yield* actor.send(PaymentEvent.SelectMethod({ method: "bridge" }));
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

        yield* actor.send(PaymentEvent.StartCheckout({ amount: 100 }));
        yield* actor.send(PaymentEvent.SelectMethod({ method: "card" }));
        yield* actor.send(PaymentEvent.PaymentFailed({ error: "Card declined", canRetry: false }));
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
