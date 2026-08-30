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

## State-owned resource

```ts
machine.spawn(State.Active, ({ self }) =>
  Stream.runForEach(device.events, (event) => self.send(Event.DeviceInput(event))),
);
```

The state scope closes on exit. Effect finalizers remove listeners, interrupt streams, and stop state-owned child actors.

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
