# Atom and UI integration

Import the framework-neutral adapter from one subpath:

```ts
import * as ActorAtom from "effect-machine/atom";
```

The actor remains the state owner. A writable Actor Atom reads actor state and sends actor events.

```ts
const stateAtom = ActorAtom.make(actor);
const countAtom = ActorAtom.select(stateAtom, (state) => state.count);
```

Selected Atoms publish only when their selected value changes. Pass an equality function when the selector returns a new object.

```ts
const totalAtom = ActorAtom.select(
  stateAtom,
  (state) => ({ cents: state.totalCents }),
  (value, next) => value.cents === next.cents,
);
```

`ActorAtom.lifecycle(actor)` exposes actor startup and exit. `ActorAtom.latestTransition(actor)` exposes the last accepted edge. Both retain their terminal value.

## Transition capability

Create one reactive capability Atom for an event:

```ts
const canCheckoutAtom = ActorAtom.can(actor, Event.Checkout);
```

The Atom evaluates the same `.when()` predicates as the actor. It supports Boolean and Effect predicates. It reevaluates after actor state changes. Effect predicates use the context captured by the actor. React can read it with `useAtomSuspense`. Solid can read it with `useAtomResource`.

The Atom gives the UI a preview. The actor evaluates the predicate again when it processes the event. Use `actor.call(event)` when the caller must inspect the authoritative `transitioned` result.

## Suspense-owned actor startup

Create the actor as an Effect Atom value:

```ts
const actorAtom = Atom.make(Machine.scoped(spawnActor));
```

- React reads it with `useAtomSuspense`.
- Solid reads it with `useAtomResource` inside `Suspense`.
- The Atom registry scope owns actor cleanup.

## Selectors and renders

Subscribe to domain selections. Do not subscribe every component to the complete state.

- The React performance test proves that a label change does not render the count or status view.
- The Solid performance test proves that a label change does not run the count or status computation.
- A selected view updates once when its selected value changes.

## Exit animations

An external store can publish the next state before an exit animation removes the old tree. Do not repair this with a component hook that keeps an arbitrary last value.

Model the retained display value in the machine state:

```ts
const ScreenState = State({
  Active: { title: Schema.String },
  Done: { title: Schema.String },
});

machine.on(ScreenState.Active, Event.Finish, ({ state }) => ScreenState.Done.with(state));
```

The old tree can read `title` during exit. The final state is still available after the actor exits.

See the working [React application](../examples/react/src/app.tsx), [React render test](../examples/react/src/selector-performance.perf.tsx), [Solid application](../examples/solid/src/app.tsx), and [Solid computation test](../examples/solid/src/selector-performance.perf.tsx).
