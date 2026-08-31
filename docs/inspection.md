# Inspection

Pass `inspect` when you spawn one actor. The inspector uses the machine state and event types.

```ts
const actor =
  yield *
  Machine.spawn(machine, {
    inspect: consoleInspector(),
  });
```

You can also provide `InspectorService` as an ambient Effect service. The spawn option replaces the ambient inspector for that actor.

Inspection events cover:

- actor spawn
- event receipt
- named predicate result
- named accepted transition operation
- accepted transition
- state-owned Effect start
- named task start, success, typed failure, defect, and interruption
- defects
- actor stop

Use a named predicate function to make a decision visible:

```ts
machine.when(
  State.Checking,
  Event.Continue,
  function hasStock({ state }) {
    return state.stock > 0;
  },
  () => State.Accepted,
);
```

Use a named transition handler to make the accepted operation visible:

```ts
machine.on(State.Accepted, Event.Submit, function submitOrder({ state }) {
  return State.Submitted.with(state);
});
```

Each inspection event includes the actor generation. Generation zero is the first run. The value increases after each supervised restart.

The console inspector logs readable machine events with Effect logging. The tracing inspector emits spans and events. The collecting inspector stores typed events for tests. `combineInspectors` runs inspectors in order. It isolates each inspector failure.

Use `actor.system.inspect` when an inspection consumer loads after an actor starts. The system inspector receives events from all actors in that system.

```ts
const actor = yield * Machine.spawn(machine);
yield * actor.start;

const unregister = actor.system.inspect(
  makeInspector((event) => {
    events.push(event);
  }),
);
yield * actor.send(Event.Refresh);
unregister();
```

The late inspector receives future events. It does not receive prior events. A system inspector is heterogeneous. Use `makeInspector()` without machine-specific type arguments. The runtime runs the actor inspector first. It then runs system inspectors in registration order. It waits for each inspector. It isolates each failure.

Effect code can scope a late registration with `Effect.acquireRelease`.

```ts
yield *
  Effect.acquireRelease(
    Effect.sync(() => actor.system.inspect(consoleInspector())),
    (unregister) => Effect.sync(unregister),
  );
```

Do not log secrets in state, events, or tracing attributes.

See [`inspection.ts`](../examples/core/src/inspection.ts).
