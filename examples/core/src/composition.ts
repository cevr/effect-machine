import { Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

const CartState = State({
  Ready: { cartId: Schema.String, totalCents: Schema.Finite },
});
const CartEvent = Event({ Refresh: {} });

const cartMachine = Machine.make({
  state: CartState,
  event: CartEvent,
  initial: CartState.Ready({ cartId: "cart-123", totalCents: 4200 }),
}).final(CartState.Ready, ({ state }) => ({
  cartId: state.cartId,
  totalCents: state.totalCents,
}));

const PaymentState = State({
  Charged: { receiptId: Schema.String },
});
const PaymentEvent = Event({ Refresh: {} });

const paymentMachine = Machine.make({
  state: PaymentState,
  event: PaymentEvent,
  initial: (input: { readonly cartId: string; readonly totalCents: number }) =>
    PaymentState.Charged({ receiptId: `${input.cartId}-${input.totalCents}` }),
}).final(PaymentState.Charged, ({ state }) => state.receiptId);

export const compositionProgram = Machine.run(cartMachine).pipe(
  Effect.flatMap((cart) => Machine.run(paymentMachine, { input: cart })),
);
