import { Context, Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

export const CheckoutState = State({
  Cart: { total: Schema.Finite },
  Checkout: { total: Schema.Finite },
});

export const CheckoutEvent = Event({ Checkout: {} });

export class CheckoutPolicy extends Context.Service<
  CheckoutPolicy,
  { readonly allows: (total: number) => Effect.Effect<boolean> }
>()("effect-machine/examples/core/CheckoutPolicy") {}

export const checkoutMachine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  initial: CheckoutState.Cart({ total: 25 }),
}).when(
  CheckoutState.Cart,
  CheckoutEvent.Checkout,
  ({ state }) => Effect.flatMap(CheckoutPolicy, (policy) => policy.allows(state.total)),
  ({ state }) => CheckoutState.Checkout.with(state),
);

export const runEffectGuard = Effect.gen(function* () {
  const actor = yield* Machine.spawn(checkoutMachine).pipe(
    Effect.provideService(CheckoutPolicy, {
      allows: (total) => Effect.succeed(total <= 50),
    }),
  );
  yield* actor.start;
  const canCheckout = yield* actor.can(CheckoutEvent.Checkout);
  const result = yield* actor.call(CheckoutEvent.Checkout);
  yield* actor.stop;
  return { canCheckout, state: result.newState };
});
