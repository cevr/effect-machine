# Effect model

Effect Machine adds state-machine semantics to Effect. It does not add a second effect system.

## Channels

| Concern                  | Owner                                               |
| ------------------------ | --------------------------------------------------- |
| Current domain state     | Machine state                                       |
| External event           | Machine event                                       |
| Actor construction value | Machine input                                       |
| Final domain value       | Machine output                                      |
| Runtime service          | Effect requirement `R`                              |
| Expected failure         | Effect error `E` before it becomes a state or event |
| Resource lifetime        | Effect `Scope`                                      |
| Workflow sequence        | `Effect.flatMap` or `Effect.gen`                    |

Machine state replaces the mutable `context` object used by many state-machine APIs. Each tagged state owns only the fields that are valid in that state. `State.with` copies shared fields when a transition needs them.

## No action layer

Effect Machine has no `Machine.action` API and no action queue.

- Return the next state from `.on`, `.reenter`, or `.immediate`.
- Use `.task` when work produces a completion event.
- Use `.spawn` when work belongs to one state.
- Use `.background` when work belongs to the actor.
- Use an Effectful transition when the work must finish before the next state becomes visible.

An Effectful transition must have `never` in its error channel. Convert an expected failure to a state or event before the handler returns. An unhandled defect stops the actor.

## Requirements

Every handler requirement becomes a requirement of the machine. `Machine.spawn`, `Machine.run`, and `system.spawn` keep that requirement in their Effect type. The application cannot start the machine until it provides the required services.

```ts
const program = Machine.run(machine, { input }).pipe(Effect.provide(AppLayer));
```

## Input, state, and output

Input creates the initial state. Input is not mutable state and is not a service.

```ts
const machine = Machine.make({
  state: CheckoutState,
  event: CheckoutEvent,
  initial: (input: CheckoutInput) => CheckoutState.Reviewing(input),
}).final(CheckoutState.Done, ({ state }) => ({ receiptId: state.receiptId }));
```

The actor retains its final state. `awaitOutput` returns the separate output value. This lets a UI keep final display data while a caller receives a smaller domain result.

## Composition

Use Effect to compose autonomous machines:

```ts
const program = Machine.run(cartMachine).pipe(
  Effect.flatMap((cart) => Machine.run(checkoutMachine, { input: cart })),
);
```

Use a parent machine when a person interacts with several phases. The parent state can retain shared values, own child actors, route events, and control visible transitions.

See the working [`composition.ts`](../examples/core/src/composition.ts) and [`actor-system.ts`](../examples/core/src/actor-system.ts) examples.
