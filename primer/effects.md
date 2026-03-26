# State Effects

State-scoped effects with `.spawn()` and machine-lifetime effects with `.background()`.

## spawn: State-Scoped Effects

`.spawn()` runs effects when entering a state. **Auto-cancelled on state exit.**

```ts
const MyEffects = Slot.Effects({
  pollStatus: { interval: Schema.Number },
  fetchData: { url: Schema.String },
});

machine
  .spawn(State.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
  .build({
    fetchData: ({ url }, { self }) =>
      Effect.gen(function* () {
        // This runs when entering Loading
        const data = yield* Http.get(url);
        yield* self.send(Event.Resolve({ data }));
      }),
  });
```

**Key behaviors**:

- Forked into state scope - runs concurrently with event processing
- Automatically interrupted when state exits
- Use `Effect.addFinalizer()` for cleanup

## task: Invoke-Style Work

`.task()` runs an effect on state entry and sends success/failure events:

```ts
machine
  .on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url }))
  .task(State.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }), {
    onSuccess: (data) => Event.Resolve({ data }),
    onFailure: () => Event.Reject({ message: "fetch failed" }),
  });
```

**Notes**:

- Runs concurrently (state-scoped, like `spawn`)
- Interrupts do **not** emit failure events
- If `onFailure` is omitted, defects are rethrown

## Cleanup with Finalizers

Add cleanup logic that runs on state exit:

```ts
.build({
  fetchData: ({ url }, { self }) =>
    Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.log("Cleaning up fetch...")
      );

      const data = yield* Http.get(url);
      yield* self.send(Event.Resolve({ data }));
    }),
})
```

Finalizer runs whether effect completes, fails, or is interrupted.

## timeout: State Timeouts

`.timeout()` — gen_statem-style state timeouts. Timer starts on state entry, cancels on state exit.

```ts
machine
  .timeout(State.Loading, {
    duration: Duration.seconds(30),
    event: Event.Timeout,
  })
  .on(State.Loading, Event.Timeout, () => State.TimedOut)
  .final(State.TimedOut);
```

**Dynamic duration** from state data:

```ts
machine.timeout(State.Retrying, {
  duration: (state) => Duration.seconds(state.backoff),
  event: Event.GiveUp,
});
```

**Dynamic event** from state data:

```ts
machine.timeout(State.Waiting, {
  duration: Duration.seconds(10),
  event: (state) => Event.Expired({ reason: state.reason }),
});
```

**Key behaviors**:

- Compiles to `.task()` internally — preserves `@machine.task` inspection events
- `.reenter()` restarts the timer with fresh state values
- Timer auto-cancelled if state exits before timeout fires

## postpone: Event Postpone

`.postpone()` — gen_statem-style event postpone. When a matching event arrives in the given state, it is buffered instead of processed. After the next state transition (tag change), all buffered events are drained in FIFO order.

```ts
machine
  .postpone(State.Connecting, Event.Data) // single event
  .postpone(State.Connecting, [Event.Data, Event.Cmd]); // multiple events
```

**Key behaviors**:

- Events buffered in FIFO order
- Drained after next state tag change (not same-state transitions)
- Reply-bearing events (`call`/`ask`) in the buffer are settled with `ActorStoppedError` on stop/interrupt/final-state
- `ProcessEventResult.postponed` is `true` for postponed events

**Use case**: connection establishment patterns where data events arrive before the connection is ready:

```ts
const machine = Machine.make({
  state: State({ Connecting: {}, Connected: {}, Closed: {} }),
  event: Event({ Connected: {}, Data: { payload: Schema.String }, Close: {} }),
  initial: State.Connecting,
})
  .on(State.Connecting, Event.Connected, () => State.Connected)
  .on(State.Connected, Event.Data, ({ event }) => {
    // Process data...
    return State.Connected;
  })
  .on(State.Connected, Event.Close, () => State.Closed)
  // Data events arriving while connecting are buffered, replayed after Connected
  .postpone(State.Connecting, Event.Data)
  .final(State.Closed)
  .build();
```

## Timeouts via spawn (manual pattern)

For more complex timeout logic, use `.spawn()` directly:

```ts
const MyEffects = Slot.Effects({
  scheduleTimeout: { duration: Schema.String },
});

machine
  .on(State.Waiting, Event.Timeout, () => State.TimedOut)
  .spawn(State.Waiting, ({ effects }) => effects.scheduleTimeout({ duration: "30 seconds" }))
  .final(State.TimedOut)
  .build({
    scheduleTimeout: ({ duration }, { self }) =>
      Effect.sleep(duration).pipe(Effect.andThen(self.send(Event.Timeout))),
  });
```

Timer auto-cancelled if state exits before timeout.

## Polling via spawn

Continuous polling while in a state:

```ts
.spawn(State.Monitoring, ({ effects }) =>
  effects.poll()
)
.build({
  poll: (_, { self }) =>
    Effect.forever(
      Effect.gen(function* () {
        const status = yield* checkStatus();
        if (status === "done") {
          yield* self.send(Event.Complete);
        }
        yield* Effect.sleep("5 seconds");
      })
    ),
})
```

Polling stops automatically when leaving Monitoring state.

## background: Machine-Lifetime Effects

`.background()` runs effects for the entire machine lifetime:

```ts
.background(({ effects }) => effects.heartbeat())
.build({
  heartbeat: (_, { self }) =>
    Effect.forever(
      Effect.sleep("30 seconds").pipe(
        Effect.andThen(self.send(Event.Ping))
      )
    ),
})
```

**Key difference from spawn**:

- Starts when machine spawns
- Runs until machine stops (final state or explicit stop)
- Not tied to any specific state

## Spawning Child Actors from Effects

Use `self.spawn` in `.spawn()` or `.background()` handlers to create child actors:

```ts
machine
  .spawn(State.Supervising, ({ self }) =>
    Effect.gen(function* () {
      // Spawn children — state-scoped, auto-stopped on state exit
      const worker1 = yield* self.spawn("worker-1", workerMachine).pipe(Effect.orDie);
      const worker2 = yield* self.spawn("worker-2", workerMachine).pipe(Effect.orDie);

      yield* worker1.send(WorkerEvent.Start);
      yield* worker2.send(WorkerEvent.Start);

      // Wait for both to finish
      yield* worker1.awaitFinal;
      yield* worker2.awaitFinal;

      yield* self.send(Event.AllDone);
    }),
  )
  .build();
```

**Key**: `self.spawn` returns `Effect<ActorRef, DuplicateActorError, R>`. Handlers require error = `never`, so use `Effect.orDie` to convert the error.

Children can also be spawned from slot implementations in `.build()`:

```ts
.build({
  startWorker: ({ id }, { self }) =>
    self.spawn(id, workerMachine).pipe(Effect.orDie),
})
```

## Multiple Spawn Effects

Multiple effects can run in the same state:

```ts
machine
  .spawn(State.Active, ({ effects }) => effects.pollStatus())
  .spawn(State.Active, ({ effects }) => effects.syncData())
  .timeout(State.Active, { duration: Duration.minutes(5), event: Event.Timeout });
```

All run concurrently, all cancelled on state exit.

## Sending Events from Effects

Use `self.send()` to send events back to the machine:

```ts
.build({
  fetchData: ({ url }, { self }) =>
    Effect.gen(function* () {
      const result = yield* Effect.either(Http.get(url));

      if (result._tag === "Left") {
        yield* self.send(Event.Reject({ error: result.left.message }));
      } else {
        yield* self.send(Event.Resolve({ data: result.right }));
      }
    }),
})
```

**Important**: `self.send()` is non-blocking. Event queued for processing.

## Testing Spawn Effects

`simulate()` and `createTestHarness()` don't run spawn effects - they test pure transitions.

For spawn effects, use real actors with `TestClock`:

```ts
import { TestClock } from "effect";

it.scoped("timeout fires after duration", () =>
  Effect.gen(function* () {
    const system = yield* ActorSystemService;
    const actor = yield* system.spawn("test", machine);

    yield* actor.send(Event.Start);
    yield* yieldFibers; // Let spawn effect start

    expect(actor.sync.matches("Waiting")).toBe(true);

    yield* TestClock.adjust("30 seconds");
    yield* yieldFibers;

    expect(actor.sync.matches("TimedOut")).toBe(true);
  }).pipe(Effect.provide(ActorSystemDefault)),
);
```

## Reenter for Timer Reset

Use `.reenter()` to restart spawn effects on same state:

```ts
machine
  .spawn(State.Active, ({ effects }) => effects.scheduleInactivityTimeout())
  // Normal transition - won't restart timeout
  .on(State.Active, Event.Update, ({ event }) => State.Active({ data: event.data }))
  // Reenter - WILL restart timeout
  .reenter(State.Active, Event.Activity, ({ state }) =>
    State.Active({ ...state, lastActivity: Date.now() }),
  );
```

## See Also

- `handlers.md` - Transition handlers
- `testing.md` - Testing with spawn effects
- `actors.md` - Actor lifecycle
