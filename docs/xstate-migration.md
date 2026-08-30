# Migration from XState

This guide uses patterns found in a large kiosk application. That application has a root session router, checkout and menu routers, named actors, device callback actors, selector-heavy React views, delayed transitions, persisted snapshots, and exit animations.

## Concept map

| XState pattern                  | Effect Machine form                                         |
| ------------------------------- | ----------------------------------------------------------- |
| `setup().createMachine()`       | `Machine.make()` fluent builder                             |
| machine `context`               | fields on tagged machine states                             |
| machine `input`                 | `initial: (input) => State.X(input)`                        |
| machine `output`                | `.final(State.X, mapper)`                                   |
| `assign`                        | return a new state, often with `State.X.with`               |
| guarded transition array        | repeated `.when()` calls and an `.on()` fallback            |
| `always`                        | `.immediate`                                                |
| invoked promise actor           | `.task`                                                     |
| invoked callback actor          | `.spawn` with an Effect resource or Stream                  |
| root invoked child machine      | `self.spawn` in `.spawn` or `.background`                   |
| machine-wide invoked listener   | `.background`                                               |
| `after`                         | `.timeout`                                                  |
| deferred event handling         | `.postpone`                                                 |
| `sendTo`                        | child `ActorRef.send` or named system lookup                |
| `waitFor`                       | `actor.waitFor`                                             |
| actor registry                  | `ActorSystemService`                                        |
| `useSelector`                   | `ActorAtom.select` plus a framework Atom hook               |
| inspector action and guard logs | task, Effect, transition, and named guard inspection events |

## Root routers

Keep a root session machine for visible application phases. Spawn one child for the active phase. State scope stops the child when the route changes.

Do not compose interactive screens only with `Effect.flatMap`. An Effect sequence has no parent state for navigation, retained UI data, or cross-phase events. Use `Effect.flatMap` for autonomous jobs. Use a parent machine for interactive routing.

See [`actor-system.ts`](../examples/core/src/actor-system.ts).

## Device callback actors

The kiosk application starts one callback actor per visible machine state. The callback observes actor snapshots. It removes the previous key listener. It then maps directional input to actor events.

In Effect Machine, model the device as a service with a `Stream` or scoped subscription. Consume it in `.spawn(State.Visible, ...)`. The state scope owns listener removal. This removes the separate callback actor protocol.

See [`hardware-navigation.ts`](../examples/core/src/hardware-navigation.ts).

## Assign and action arrays

Do not migrate `actions: []` as a new action list.

- Context assignments become one returned tagged state.
- Async work that reports a result becomes a task.
- State entry subscriptions become state-owned Effects.
- Telemetry becomes an Effect service call.
- Work that must complete before publication becomes an Effectful transition.

If several updates must be atomic, compute one next state in one transition handler.

## Invoked work

Map promise actors to `.task`. The task name appears in inspection. Map callback actors to `.spawn` or `.background`. Use `Effect.acquireRelease`, `Effect.async`, or `Stream` to express listener cleanup.

The machine type records all service requirements. A missing API, bridge, storage, or device service prevents actor startup at compile time.

## Selectors

Create one writable Actor Atom for the actor. Derive stable selections with `ActorAtom.select`. Select primitives or stable references when possible. Add an equality function for object projections.

Do not put component callbacks into machine state. Keep domain state in the actor. Keep view composition in the framework.

## Exit animations and temporary values

The kiosk application keeps temporary values because the external store publishes the new machine state before Motion removes the old screen.

Prefer a domain fix:

1. Identify the old tree data that remains valid during exit.
2. Carry that data into the next or final tagged state.
3. Select the value from every state that renders it.
4. Let the animation library own only mount retention.

Use a UI-local retained value only when the value is purely visual and has no domain meaning. Do not let that local value become a second machine context.

See [Atom and UI integration](./atom-and-ui.md).

## Persistence

Use `lifecycle.recovery` and `lifecycle.durability` for actor state that must survive a new local actor. Use terminal state retention only for the existing actor reference. These are different lifetimes.

See [Persistence and supervision](./persistence-and-supervision.md).

## Migration order

1. Define schema-first states and events.
2. Move context fields into the state variants that own them.
3. Port unconditional edges with `.on()` and conditional edges with `.when()`.
4. Port `always`, delays, and postponed events.
5. Port invoked promise work as tasks.
6. Port callback actors as scoped Effect resources or Streams.
7. Rebuild the root actor topology with `ActorSystemService` and child actors.
8. Add Atom selectors and render-count tests.
9. Add inspection, recovery, durability, and supervision.
10. Remove temporary retained-value hooks after state variants retain required exit data.
