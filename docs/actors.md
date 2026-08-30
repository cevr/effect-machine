# Actors and systems

## Direct actor

`Machine.spawn` allocates an unstarted actor. Start it and stop it, or attach it to an Effect scope.

```ts
const program = Effect.scoped(
  Machine.scoped(
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* actor.send(Event.Start);
      return yield* actor.awaitOutput;
    }),
  ),
);
```

Use `Machine.run` for an autonomous actor. It starts the actor, waits for output, and stops the actor on success, failure, or interruption.

## Actor system

Use `ActorSystemService` for named lookup and multi-actor coordination. `system.spawn` starts the actor.

```ts
const system = yield * ActorSystemService;
const actor = yield * system.spawn("checkout", checkoutMachine);
const maybeActor = yield * system.get("checkout");
```

Terminal actors leave the registry. A stopped actor keeps its final snapshot and lifecycle value through its existing `ActorRef`.

Use a typed key when lookup callers must keep the machine state, event, and output types.

```ts
const CheckoutActor = actorSystemKey<CheckoutState, CheckoutEvent>("checkout");

const actor = yield * system.spawn(CheckoutActor, checkoutMachine);
const maybeActor = yield * system.get(CheckoutActor);
const generations = system.watch(CheckoutActor);
```

`watch` starts with the current actor or `Option.none()`. It then emits only when that ID starts or stops. A later actor generation with the same key emits its new `ActorRef`.

## Parent and child actors

Spawn a child from a state-owned Effect:

```ts
machine.spawn(State.Menu, ({ self }) =>
  self.spawn("menu", menuMachine).pipe(Effect.asVoid, Effect.orDie),
);
```

The child uses the same actor system. The child stops when the parent exits the owning state. A child from `.background` lives until the parent actor stops.

This pattern replaces a root router that invokes one screen actor for each route. See [`actor-system.ts`](../examples/core/src/actor-system.ts).

## ActorRef selection

- `send` queues an event and returns.
- `call` waits for event processing and returns `ProcessEventResult`.
- `ask` returns the schema-checked reply for an `Event.reply` event.
- `waitFor` waits for a state constructor or predicate.
- `awaitFinal` returns the retained final state.
- `awaitOutput` returns the final output.
- `awaitExit` returns `Final`, `Stopped`, or `Defect`.
- `client` exposes send, stop, snapshot, matching, subscription, and Promise-based capability checks outside Effect.
- `client.canSync` supports Boolean transition predicates only.
- React and Solid should use Actor Atoms for state and capability subscriptions.
