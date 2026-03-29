# effect-machine

Type-safe state machines for [Effect](https://effect.website).

Complex workflows usually fail the same way: one `status` field, a few side booleans, and effects scattered across callbacks. `effect-machine` gives you one typed model for state, events, and transitions, then runs it as a real actor.

Use it when a feature has:

- multiple valid and invalid states
- async work tied to state entry
- retries, timeouts, cancellation, or backpressure
- logic you want to reuse in-process, in tests, and in distributed systems

## Install

```bash
bun add effect-machine effect
```

## Core Pattern

States and events are schemas. Types, validation, and serialization from one place.

```ts
import { Schema } from "effect";
import { Event, Machine, Slot, State } from "effect-machine";

const CheckoutState = State({
  ReviewingCart: { cartId: Schema.String, totalCents: Schema.Number },
  ChargingCard: { cartId: Schema.String, totalCents: Schema.Number },
  Confirmed: { cartId: Schema.String, receiptId: Schema.String },
  Failed: { cartId: Schema.String, reason: Schema.String },
});

const CheckoutEvent = Event({
  Submit: {},
  Charged: { receiptId: Schema.String },
  Declined: { reason: Schema.String },
  Cancel: {},
});

const CheckoutEffects = Slot.Effects({
  chargeCard: { cartId: Schema.String, totalCents: Schema.Number },
});

const checkoutMachine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  effects: CheckoutEffects,
  initial: CheckoutState.ReviewingCart({ cartId: "cart_123", totalCents: 4200 }),
})
  .on(CheckoutState.ReviewingCart, CheckoutEvent.Submit, ({ state }) =>
    CheckoutState.ChargingCard.derive(state),
  )
  .on(CheckoutState.ChargingCard, CheckoutEvent.Charged, ({ state, event }) =>
    CheckoutState.Confirmed.derive(state, { receiptId: event.receiptId }),
  )
  .on(CheckoutState.ChargingCard, CheckoutEvent.Declined, ({ state, event }) =>
    CheckoutState.Failed.derive(state, { reason: event.reason }),
  )
  .onAny(CheckoutEvent.Cancel, ({ state }) =>
    CheckoutState.Failed.derive(state, { reason: "cancelled" }),
  )
  .spawn(CheckoutState.ChargingCard, ({ effects, state }) =>
    effects.chargeCard({ cartId: state.cartId, totalCents: state.totalCents }),
  )
  .final(CheckoutState.Confirmed)
  .final(CheckoutState.Failed);
```

A few things to notice:

- Empty variants are values: `State.Idle`. Non-empty are constructors: `State.Loading({ url })`.
- `State.derive(source, overrides)` carries overlapping fields forward without manual copying.
- `.onAny(...)` is a fallback; a specific `.on(...)` wins.
- `.spawn(...)` runs work on state entry and cancels it on state exit.

The builder also supports `.timeout(state, { duration, event })`, `.postpone(state, event)` for buffering, and `.reenter(...)` for re-running lifecycle on same-state transitions.

## Slots

Slots separate what a machine needs from how the app provides it. Declare them on the machine, provide implementations where you run it.

```ts
const actor =
  yield *
  Machine.spawn(checkoutMachine, {
    slots: {
      chargeCard: ({ cartId, totalCents }, { self }) =>
        Effect.gen(function* () {
          const result = yield* PaymentService.charge(cartId, totalCents);
          yield* self.send(
            result.ok
              ? CheckoutEvent.Charged({ receiptId: result.receiptId })
              : CheckoutEvent.Declined({ reason: result.error }),
          );
        }),
    },
  });
```

The same machine can run with different slot implementations in tests, local apps, or production. Slots are accepted everywhere the machine runs:

- `Machine.spawn(machine, { slots })`
- `Machine.replay(machine, events, { slots })`
- `simulate(machine, events, { slots })`
- `createTestHarness(machine, { slots })`

## Running Actors

`Machine.spawn` gives you a live actor with a queue and lifecycle management.

```ts
const program = Effect.gen(function* () {
  const actor = yield* Machine.spawn(checkoutMachine, {
    slots: {
      chargeCard: ({ cartId }, { self }) =>
        self.send(CheckoutEvent.Charged({ receiptId: `rcpt_${cartId}` })),
    },
  });

  yield* actor.send(CheckoutEvent.Submit);
  const finalState = yield* actor.awaitFinal;
});

Effect.runPromise(Effect.scoped(program));
```

Key actor operations:

- `send(event)` queues and returns immediately
- `call(event)` returns full transition info
- `ask(event)` returns a typed domain reply (requires `Event.reply(...)`)
- `waitFor(...)` / `awaitFinal` for coordination
- `stop` interrupts now; `drain` processes the remaining queue first
- `watch(other)` completes when another actor stops

For named actors or shared lookup, use an actor system:

```ts
import { ActorSystemDefault, ActorSystemService } from "effect-machine";

const program = Effect.gen(function* () {
  const system = yield* ActorSystemService;
  const actor = yield* system.spawn("checkout-123", checkoutMachine);
  yield* actor.send(CheckoutEvent.Submit);
}).pipe(Effect.provide(ActorSystemDefault));
```

### Typed Replies

Events can declare typed reply schemas:

```ts
const CartEvent = Event({
  GetTotal: Event.reply({}, Schema.Number),
});

machine.on(State.Active, CartEvent.GetTotal, ({ state }) => Machine.reply(state, state.totalCents));

const total = yield * actor.ask(CartEvent.GetTotal); // number
```

## Testing

Test transitions without spawning actors:

```ts
import { simulate } from "effect-machine";

const result =
  yield *
  simulate(
    checkoutMachine,
    [CheckoutEvent.Submit, CheckoutEvent.Charged({ receiptId: "rcpt_123" })],
    { slots: { chargeCard: () => Effect.void } },
  );

expect(result.states.map((s) => s._tag)).toEqual(["ReviewingCart", "ChargingCard", "Confirmed"]);
```

`simulate` and `createTestHarness` test transition logic. They do not run `.spawn()` or `.background()` effects.

## Cluster

When the same machine needs to run behind `@effect/cluster`, turn it into an entity:

```ts
import { EntityMachine, toEntity } from "effect-machine/cluster";

const CheckoutEntity = toEntity(checkoutMachine, { type: "Checkout" });

const CheckoutEntityLayer = EntityMachine.layer(CheckoutEntity, checkoutMachine, {
  initializeState: (entityId) => CheckoutState.ReviewingCart({ cartId: entityId, totalCents: 0 }),
  persistence: { strategy: "journal" },
});
```

Persistence strategies:

- **Snapshot** — saves state periodically, restores on reactivation
- **Journal** — appends events on each RPC, replays on reactivation

## License

MIT
