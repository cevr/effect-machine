# effect-machine

Type-safe state machines for [Effect](https://effect.website).

Effect Machine gives one actor a schema-first state model, a typed event mailbox, scoped Effect work, typed input and output, supervision, persistence hooks, inspection, and framework-neutral Atom integration.

Use it when a feature has several valid states, invalid transitions, state-owned async work, timeouts, cancellation, actor coordination, or UI views that need precise subscriptions.

## Install

```bash
bun add effect-machine effect
```

`effect` is a required peer dependency.

## Imports

```ts
import { Event, Machine, State } from "effect-machine";
import * as ActorAtom from "effect-machine/atom";
import { EntityMachine, toEntity } from "effect-machine/cluster";
```

Use `effect-machine` for local machines and actors. Use `effect-machine/atom` for React, Solid, or another Effect Atom binding. Use `effect-machine/cluster` for distributed entity machines.

## First machine

States and events are Effect schemas.

```ts
import { Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

const DownloadState = State({
  Idle: {},
  Downloading: { url: Schema.String },
  Done: { url: Schema.String, bytes: Schema.Finite },
  Failed: { url: Schema.String, message: Schema.String },
});

const DownloadEvent = Event({
  Start: { url: Schema.String },
  Completed: { bytes: Schema.Finite },
  Failed: { message: Schema.String },
});

const downloadMachine = Machine.make({
  state: DownloadState,
  event: DownloadEvent,
  initial: DownloadState.Idle,
})
  .on(DownloadState.Idle, DownloadEvent.Start, ({ event }) =>
    DownloadState.Downloading({ url: event.url }),
  )
  .on(DownloadState.Downloading, DownloadEvent.Completed, ({ state, event }) =>
    DownloadState.Done.with(state, { bytes: event.bytes }),
  )
  .on(DownloadState.Downloading, DownloadEvent.Failed, ({ state, event }) =>
    DownloadState.Failed.with(state, { message: event.message }),
  )
  .final(DownloadState.Done, ({ state }) => state.bytes)
  .final(DownloadState.Failed, () => 0);

const program = Effect.scoped(
  Machine.scoped(
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(downloadMachine);
      yield* actor.start;
      yield* actor.send(DownloadEvent.Start({ url: "/report.pdf" }));
      yield* actor.send(DownloadEvent.Completed({ bytes: 1024 }));
      return yield* actor.awaitOutput;
    }),
  ),
);
```

An empty variant is a value such as `DownloadState.Idle`. A non-empty variant is a constructor such as `DownloadState.Downloading({ url })`.

`State.with(source, fields)` copies matching fields into the target variant. It prevents manual context spreading across different states.

## Effect is the composition layer

Effect Machine does not add an action queue or a second context system.

| Work                                  | API                                          |
| ------------------------------------- | -------------------------------------------- |
| Unconditional state change            | `.on`, `.reenter`, or `.immediate`           |
| Conditional state change              | `.when`, `.reenterWhen`, or `.immediateWhen` |
| Work that produces a completion event | `.task`                                      |
| State-owned stream or resource        | `.spawn`                                     |
| Actor-owned stream or resource        | `.background`                                |
| Autonomous machine sequence           | `Machine.run` with `Effect.flatMap`          |
| Interactive multi-phase flow          | Parent machine with child actors             |

Effect requirements remain in `R`. A machine cannot start until the application provides every required service. Effectful transition handlers must have `never` in their error channel. Convert expected failures to states or events.

Machine-lifetime backgrounds can read `self.state` and `self.latestTransition`. These are the
actor-owned subscription refs. They stay stable across supervision generations. Treat them as
read-only and use `SubscriptionRef.get` or `SubscriptionRef.changes` to observe them.

Read [the Effect model](./docs/effect-model.md) and [async work ownership](./docs/async-work.md).

## Guards and stable state

Register ordered candidates for one state and event. The first passing guard wins. An unguarded candidate is the fallback.

```ts
machine
  .when(
    State.Checking,
    Event.Continue,
    function hasStock({ state }) {
      return state.stock > 0;
    },
    () => State.Accepted,
  )
  .on(State.Checking, Event.Continue, () => State.Rejected)
  .immediate(State.Accepted, ({ state }) => State.Ready.with(state));
```

The predicate can return a Boolean or `Effect<boolean, never, R>`. Its requirements flow into the machine type. `actor.can(event)` evaluates the same predicate with the actor's captured context. `ActorAtom.can(actor, event)` exposes the result to React and Solid. The inspector uses the predicate function name.

Immediate transitions run until the state is stable. Subscribers see only the stable state. The runtime stops an accidental eventless loop after 100 edges.

## Effect services and tasks

```ts
class Api extends Context.Service<
  Api,
  { readonly load: (id: string) => Effect.Effect<Data, ApiError> }
>()("app/Api") {}

machine.task(State.Loading, ({ state }) => Effect.flatMap(Api, (api) => api.load(state.id)), {
  name: "load-data",
  onSuccess: (data) => Event.Loaded({ data }),
  onFailure: (error) => Event.LoadFailed({ message: String(error) }),
});

const actor = yield * Machine.spawn(machine).pipe(Effect.provide(ApiLive));
yield * actor.start;
```

The actor captures the Effect context during allocation. It keeps those services when it starts later.

`onFailure` receives the typed Effect error. A defect does not enter `onFailure`. It stops the actor or starts supervision.

## Input, output, and composition

```ts
const checkoutMachine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  initial: (input: CheckoutInput) => CheckoutState.Reviewing(input),
}).final(CheckoutState.Done, ({ state }) => ({ receiptId: state.receiptId }));

const program = Machine.run(cartMachine).pipe(
  Effect.flatMap((cart) => Machine.run(checkoutMachine, { input: cart })),
);
```

`Machine.run` starts one actor, waits for output, and always stops it. Interruption releases actor resources. The final actor state remains available when you use `Machine.spawn` and retain the actor reference.

Use a parent machine when a UI must route between phases, keep shared values, or support back navigation. Read [Actors and systems](./docs/actors.md).

## ActorRef

| Member                      | Use                                                |
| --------------------------- | -------------------------------------------------- |
| `start`                     | Start a direct actor                               |
| `send(event)`               | Queue an event                                     |
| `call(event)`               | Process an event and return transition information |
| `ask(event)`                | Return a typed reply from an `Event.reply` event   |
| `waitFor(state)`            | Wait for a state constructor or predicate          |
| `sendAndWait(event, state)` | Send and wait for a state                          |
| `snapshot`                  | Read the current state as an Effect                |
| `awaitFinal`                | Wait for the final state                           |
| `awaitOutput`               | Wait for typed output                              |
| `awaitExit`                 | Wait for `Final`, `Stopped`, or `Defect`           |
| `drain`                     | Process queued events and stop                     |
| `subscribe`                 | Observe state with a host callback                 |
| `client`                    | Use the actor outside Effect                       |
| `system`                    | Access named actors                                |
| `children`                  | Read direct child actors                           |

`Machine.spawn` returns an unstarted actor. `system.spawn` starts the actor.

Use `actor.client` in a JavaScript callback or application that does not run inside Effect. `client.can(event)` returns a Promise and supports Effect predicates. `client.canSync(event)` supports Boolean predicates only. React and Solid should use Actor Atoms.

## Atom, React, and Solid

```ts
import * as ActorAtom from "effect-machine/atom";

const stateAtom = ActorAtom.make(actor);
const countAtom = ActorAtom.select(stateAtom, (state) => state.count);
```

The selected Atom stays writable. Writes send machine events. A selector publishes only when its selected value changes.

The React example uses `useAtomSuspense` and Motion. The Solid example uses `useAtomResource`, Suspense, and `solid-transition-group`. Both include performance tests. Both retain exit-animation data in the terminal machine state.

Read [Atom and UI integration](./docs/atom-and-ui.md) and browse [all examples](./examples/README.md).

## Persistence, supervision, and inspection

- Recovery resolves state during actor startup.
- Durability saves committed transitions.
- Supervision restarts defects within an Effect `Schedule` budget.
- Inspection reports events, named transition operations, transitions, named guards, tasks, Effects, errors, stops, and actor generations.
- Dynamic Inspector hubs let lazy tools observe existing actors without actor restart or state duplication.

Read [Persistence and supervision](./docs/persistence-and-supervision.md) and [Inspection](./docs/inspection.md).

## Testing

Use `simulate` or `createTestHarness` for transition paths. Spawn a real actor for tasks, services, resources, persistence, supervision, inspection, and actor topology.

```ts
const result = yield * simulate(machine, events, { input });
yield * assertPath(machine, events, ["Idle", "Loading", "Done"]);
yield * assertNeverReaches(machine, events, "Failed");
```

Read [Testing](./docs/testing.md).

## XState migration

The [migration guide](./docs/xstate-migration.md) covers context, assign, actions, invoked promise and callback actors, root routers, actor registries, selectors, inspection, persistence, and exit animation values. Its patterns come from a large XState kiosk application.

## Cluster entities

Use `effect-machine/cluster` to expose a machine through Effect Cluster. It supports typed send, ask, state reads, state watches, input adapters, snapshot persistence, and journal persistence.

Read [Cluster entities](./docs/cluster.md).

## Examples

The examples directory is a Bun workspace.

```bash
bun run examples:gate
bun run example:react
bun run example:solid
```

The [example matrix](./examples/README.md) links every pattern to executable code.

## Documentation

- [Effect model](./docs/effect-model.md)
- [Async work](./docs/async-work.md)
- [Actors and systems](./docs/actors.md)
- [Atom and UI integration](./docs/atom-and-ui.md)
- [Persistence and supervision](./docs/persistence-and-supervision.md)
- [Inspection](./docs/inspection.md)
- [Testing](./docs/testing.md)
- [Migration from XState](./docs/xstate-migration.md)
- [Cluster entities](./docs/cluster.md)
- [AI agent reference](./SKILL.md)

## License

MIT
