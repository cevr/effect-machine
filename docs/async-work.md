# Async work

Choose the API from the work lifetime and result contract.

| Need                                          | API             | Lifetime         | Result              |
| --------------------------------------------- | --------------- | ---------------- | ------------------- |
| Select a state after required Effect work     | Effectful `.on` | One mailbox step | Next state          |
| Run work and send success or failure          | `.task`         | Current state    | Event               |
| Own a stream, listener, timer, or child actor | `.spawn`        | Current state    | Events or resources |
| Own telemetry or a long-lived subscription    | `.background`   | Actor            | Events or resources |
| Delay one event                               | `.timeout`      | Current state    | Event               |
| Hold an event until state changes             | `.postpone`     | Mailbox          | Replayed event      |

## Task

```ts
machine.task(State.Loading, ({ state }) => load(state.id), {
  name: "load-order",
  onSuccess: (order) => Event.Loaded({ order }),
  onFailure: (error) => Event.LoadFailed({ message: String(error) }),
});
```

A task sends `onFailure` only for a typed Effect error. A defect stops the actor or starts supervision. A state exit interrupts the task. An interruption does not emit a failure event.

The types require each handler that the run needs:

| `run` succeeds with     | `run` can fail | The options must give       |
| ----------------------- | -------------- | --------------------------- |
| An event of the machine | No             | Nothing (`{}`)              |
| An event of the machine | Yes            | `onFailure`                 |
| Any other value         | No             | `onSuccess`                 |
| Any other value         | Yes            | `onSuccess` and `onFailure` |

"Cannot fail" means the error type is `never`. TypeScript decides both columns at the call. A type parameter counts through its constraint: a value typed `Ev` with `<Ev extends typeof Event.Done>` needs no `onSuccess`, and a value typed `A` with `<A>` does. An `any` value needs no `onSuccess`. An `any` error needs `onFailure`. A handler counts as given only when the options type declares it as required and its type excludes `undefined`. An optional `onFailure?` or an `onFailure: fn | undefined` does not count. An options value typed `any`, or a handler typed `any`, counts as given. A handler that the run does not need always compiles.

To drop a handler, map the value to an event in `run` with `Effect.map`, or make the failure a defect with `Effect.orDie`.

A call that misses a handler fails with TS2769, "No overload matches this call". TypeScript prints the error of the last overload only. That overload takes one state and requires no handler. It checks the error type of `run` first, then the value type:

- `Type 'LoadError' is not assignable to type 'never'`: `run` can fail.
  - If the options have no `onFailure`, give `onFailure`.
  - If `onFailure` is there, `run` succeeds with a value that is not an event, and the options have no `onSuccess`, give `onSuccess`.
  - If the handlers that `run` needs are there, check each handler that the options give. It must accept the type that `run` gives it: the value for `onSuccess`, the error for `onFailure`. It must return an event of the machine.
- `Type 'number' is not assignable to type '<event union>'`: a value that must be an event is not an event. The value can come from `run` or from a handler.
  - If `run` succeeds with a value that is not an event, and the options have no `onSuccess`, give `onSuccess`.
  - If the handlers that `run` needs are there, check each handler that the options give. It must accept the type that `run` gives it, and it must return an event of the machine.
- Another text, such as `Type 'number' is not assignable to type 'string'`: a handler parameter does not accept the type that `run` gives it. Fix the parameter type of that handler.
- An optional `onSuccess?` or `onFailure?`, or a handler typed `fn | undefined`, is not there.
- TS7006, "Parameter implicitly has an 'any' type", on a handler parameter comes with the TS2769 error. Fix the TS2769 error.
- A call on a list of states, such as `[State.Loading, State.Retrying]`, gets the one-state text about its states argument instead: `Argument of type '...[]' is not assignable to parameter of type 'TaggedOrConstructor<...>'`. That text does not name the handler. Check the run and the handlers against the table above.

## State-owned resource

```ts
machine.spawn(State.Active, ({ self }) =>
  Stream.runForEach(device.events, (event) => self.send(Event.DeviceInput(event))),
);
```

The state scope closes on exit. Effect finalizers remove listeners, interrupt streams, and stop state-owned child actors.

## Actor-owned state observer

Machine-lifetime work can observe the same state and latest-transition refs as the public actor.
The refs keep their identity across supervised generations. The latest transition resets before a
new generation starts.

```ts
machine.background(({ self }) =>
  SubscriptionRef.changes(self.state).pipe(
    Stream.runForEach((state) =>
      SubscriptionRef.get(self.latestTransition).pipe(
        Effect.flatMap((transition) => navigate(state, transition?.event)),
        Effect.flatMap(self.send),
      ),
    ),
  ),
);
```

Treat `self.state` and `self.latestTransition` as read-only. The actor runtime owns all writes.
Rejected events do not change either ref.

## Effectful transition

```ts
machine.on(State.Ready, Event.Submit, ({ state }) =>
  Effect.gen(function* () {
    const audit = yield* Audit;
    yield* audit.record(state);
    return State.Submitted.with(state);
  }),
);
```

This handler blocks the actor mailbox until it returns. Use it only when the next state must not become visible before the Effect completes.

See [`services-and-tasks.ts`](../examples/core/src/services-and-tasks.ts) and [`hardware-navigation.ts`](../examples/core/src/hardware-navigation.ts).
