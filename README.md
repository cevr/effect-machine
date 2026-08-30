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

`effect` is a peer dependency. The repository validates the package with
`@effect/tsgo`, the latest Effect release candidate, type-aware oxlint, and Bun tests.

## Core Pattern

States and events are schemas. Types, validation, and serialization from one place.

```ts
import { Cause, Context, Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

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

class PaymentService extends Context.Service<
  PaymentService,
  {
    readonly chargeCard: (
      cartId: string,
      totalCents: number,
    ) => Effect.Effect<{ readonly receiptId: string }>;
  }
>()("app/PaymentService") {}

const checkoutMachine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  initial: CheckoutState.ReviewingCart({ cartId: "cart_123", totalCents: 4200 }),
})
  .on(CheckoutState.ReviewingCart, CheckoutEvent.Submit, ({ state }) =>
    CheckoutState.ChargingCard.with(state),
  )
  .on(CheckoutState.ChargingCard, CheckoutEvent.Charged, ({ state, event }) =>
    CheckoutState.Confirmed.with(state, { receiptId: event.receiptId }),
  )
  .on(CheckoutState.ChargingCard, CheckoutEvent.Declined, ({ state, event }) =>
    CheckoutState.Failed.with(state, { reason: event.reason }),
  )
  .onAny(CheckoutEvent.Cancel, ({ state }) =>
    CheckoutState.Failed.with(state, { reason: "cancelled" }),
  )
  .task(
    CheckoutState.ChargingCard,
    ({ state }) =>
      Effect.flatMap(PaymentService, (payment) =>
        payment.chargeCard(state.cartId, state.totalCents),
      ),
    {
      onSuccess: ({ receiptId }) => CheckoutEvent.Charged({ receiptId }),
      onFailure: (cause) => CheckoutEvent.Declined({ reason: Cause.pretty(cause) }),
    },
  )
  .final(CheckoutState.Confirmed)
  .final(CheckoutState.Failed);
```

A few things to notice:

- Empty variants are values: `State.Idle`. Non-empty are constructors: `State.Loading({ url })`.
- `State.with(source, overrides)` carries overlapping fields forward without manual copying.
- `.onAny(...)` is a fallback; a specific `.on(...)` wins.
- `.spawn(...)` runs work on state entry and cancels it on state exit.

The builder also supports `.timeout(state, { duration, event })`, `.postpone(state, event)` for buffering, and `.reenter(...)` for re-running lifecycle on same-state transitions.

### Guards, transition Effects, and eventless transitions

Add ordered guarded candidates when one event can take more than one edge. The first passing guard wins. An unguarded candidate is a fallback. `actor.can(event)` and `actor.sync.can(event)` evaluate the same guards.

```ts
machine
  .on(
    State.Checking,
    Event.Continue,
    ({ state }) =>
      Effect.gen(function* () {
        const audit = yield* Audit;
        yield* audit.record(state);
        return State.Accepted;
      }),
    {
      guard: Machine.guard(
        "has-stock",
        ({ state }) => state.stock > 0,
        ({ state }) => ({ stock: state.stock }),
      ),
    },
  )
  .on(State.Checking, Event.Continue, () => State.Rejected)
  .immediate(State.Accepted, ({ state }) => State.Ready.with(state));
```

Effectful transition handlers run before the state becomes visible. They can use captured Effect services. Their error channel must be `never`. Convert expected failures to states or events. An unhandled defect stops the actor and emits an inspector error.

`.immediate(...)` defines an eventless transition. The actor follows eventless edges until it reaches a stable state. State subscribers see only that stable state. This also applies to the initial state. The runtime defects after 100 eventless edges to stop an accidental loop.

## Effect Services

Task, spawn, and background handlers can use standard Effect services. The machine type records each service requirement.

```ts
const actor =
  yield *
  Machine.spawn(checkoutMachine).pipe(
    Effect.provideService(PaymentService, {
      chargeCard: (cartId) => Effect.succeed({ receiptId: `rcpt_${cartId}` }),
    }),
  );
yield * actor.start;
```

`Machine.spawn` captures the current Effect context. A later `actor.start` keeps those services. Use a different layer or service value in each test or runtime.

The builder adds every transition, task, spawn, and background service to the machine requirement type. `Machine.spawn(machine)` and `system.spawn(id, machine)` do not compile at an application entry point until the caller provides all requirements.

Guards stay pure. Transition handlers can return a state directly or an Effect that returns a state. Effectful transition handlers can require services, but their error channel must be `never`.

Use one Effect context for all runtime requirements. Use `.task(...)` for work that sends a completion event. Use `.spawn(...)` for work owned by one state. Use `.background(...)` for work owned by the actor. Use an Effectful transition only when its result must select the next state before the mailbox can process another event.

## Input, Output, and Composition

A machine can map a typed input to its initial state. `Machine.spawn` then requires that input. This keeps actor construction data separate from Effect services.

```ts
const checkoutMachine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  initial: (input: { readonly cartId: string; readonly totalCents: number }) =>
    CheckoutState.ReviewingCart(input),
}).final(CheckoutState.Confirmed, ({ state }) => ({ receiptId: state.receiptId }));

const actor =
  yield *
  Machine.spawn(checkoutMachine, {
    input: { cartId: "cart_123", totalCents: 4200 },
  });
yield * actor.start;
const output = yield * actor.awaitOutput; // { readonly receiptId: string }
```

The actor keeps its final state for inspection and UI exit animation. `awaitOutput` returns the separate domain output.

Compose autonomous machine runs with Effect. This keeps sequencing, errors, requirements, cancellation, and tracing in one model.

```ts
const program = cartActor.awaitOutput.pipe(
  Effect.map((cart) => ({ cartId: cart.id, totalCents: cart.totalCents })),
  Effect.flatMap((input) => Machine.spawn(checkoutMachine, { input })),
  Effect.tap((actor) => actor.start),
  Effect.flatMap((actor) => actor.awaitOutput),
);
```

Use an explicit parent machine when a UI must show both phases or keep prior data during an exit animation. The parent state then owns the retained value and routes events to its child actors.

## Running Actors

`Machine.spawn` allocates an actor but does not start it. Call `actor.start` to fork the event loop, background effects, and spawn effects. Events sent before `start()` are queued.

```ts
const program = Effect.gen(function* () {
  const actor = yield* Machine.spawn(checkoutMachine);
  yield* actor.start;

  yield* actor.send(CheckoutEvent.Submit);
  const finalState = yield* actor.awaitFinal;
});

Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provideService(PaymentService, {
      chargeCard: (cartId) => Effect.succeed({ receiptId: `rcpt_${cartId}` }),
    }),
  ),
);
```

Key actor operations:

- `start` forks the event loop (idempotent, required after `Machine.spawn`)
- `send(event)` queues and returns immediately
- `call(event)` returns full transition info
- `ask(event)` returns a typed domain reply (requires `Event.reply(...)`)
- `waitFor(...)` / `awaitFinal` for state coordination
- `awaitOutput` for the typed domain value of a final state
- `stop` interrupts now; `drain` processes the remaining queue first
- `awaitExit` completes when the actor stops
- `lifecycle` observes `Created`, `Starting`, `Active`, and the terminal `ActorExit`
- `latestTransition` retains the latest accepted edge, including after actor exit

For named actors or shared lookup, use an actor system. `system.spawn` auto-starts — no `actor.start` needed:

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
  simulate(checkoutMachine, [
    CheckoutEvent.Submit,
    CheckoutEvent.Charged({ receiptId: "rcpt_123" }),
  ]);

expect(result.states.map((s) => s._tag)).toEqual(["ReviewingCart", "ChargingCard", "Confirmed"]);
```

`simulate` and `createTestHarness` test transition logic. They do not run `.spawn()` or `.background()` effects.

## React, Solid, and Vue

Use the Effect Atom adapter to connect one actor to any Effect Atom framework binding. The actor remains the state owner. Atom writes send typed events.

```ts
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as ActorAtom from "effect-machine/atom";

const checkoutAtom = ActorAtom.make(actor);

function CheckoutTotal() {
  const totalCents = useAtomValue(checkoutAtom, (state) =>
    "totalCents" in state ? state.totalCents : 0,
  );
  const send = useAtomSet(checkoutAtom);

  return <button onClick={() => send(CheckoutEvent.Submit)}>Pay {totalCents}</button>;
}
```

`useAtomValue` subscribes to the selected value. It does not render again when another state field changes. Use `ActorAtom.select` when you need a reusable selector or a custom equality function:

```ts
const totalAtom = ActorAtom.select(
  checkoutAtom,
  (state) => ("totalCents" in state ? { cents: state.totalCents } : { cents: 0 }),
  (value, next) => value.cents === next.cents,
);

const lifecycleAtom = ActorAtom.lifecycle(actor);
const latestTransitionAtom = ActorAtom.latestTransition(actor);
```

The selected Atom stays writable. `useAtomSet(totalAtom)` still sends checkout events. Solid uses the same Atom with `@effect/atom-solid`. Vue uses the same Atom with `@effect/atom-vue`.

Runnable React and Solid package examples are in `examples/react` and `examples/solid`.

```bash
bun run example:react
bun run example:solid
```

Each example creates the actor through `Atom.make(Machine.scoped(...))`. React reads it with `useAtomSuspense`. Solid reads it with `useAtomResource` inside a Suspense boundary. The Atom scope owns actor cleanup.

Each example has a framework performance test. The React test counts component renders. The Solid test counts reactive computations. Both tests prove that an unrelated selector does not update.

The React example uses Motion `AnimatePresence`. The Solid example uses `solid-transition-group`. Both examples keep the old screen mounted for a 200 ms exit after the machine enters `Done`.

The terminal `Done` state keeps the displayed `count` and `label`. The old screen stays valid without a local retained-value hook. Keep exit data in the terminal state or handle the terminal variant in the selector. Do not cache the last non-null selector value.

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

An input machine requires the `input` adapter. The adapter maps each entity ID to machine input:

```ts
EntityMachine.layer(CheckoutEntity, inputCheckoutMachine, {
  input: (entityId) => ({ cartId: entityId, totalCents: 0 }),
});
```

`initializeState` remains available when an entity needs to override the complete initial state.

Persistence strategies:

- **Snapshot** — saves state periodically, restores on reactivation
- **Journal** — appends events on each RPC, replays on reactivation

## License

MIT
