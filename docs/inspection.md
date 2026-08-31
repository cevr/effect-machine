# Inspection

Provide `InspectorService` when you allocate an actor. The actor captures it with the rest of its Effect context.

```ts
const actor =
  yield * Machine.spawn(machine).pipe(Effect.provideService(InspectorService, consoleInspector()));
```

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

The console inspector logs readable machine events with Effect logging. The tracing inspector emits spans and events. The collecting inspector stores typed events for tests. `combineInspectors` isolates an inspector failure from the other inspectors.

Use `makeInspectorHub` when inspection consumers load after actors start. Provide the hub Inspector before actor startup. Register and unregister sinks later without restarting actors or duplicating actor state.

```ts
const hub = makeInspectorHub<typeof State, typeof Event>();
const actor =
  yield * Machine.spawn(machine).pipe(Effect.provideService(InspectorService, hub.inspector));
yield * actor.start;

const unregister = hub.register(collectingInspector(events));
yield * actor.send(Event.Refresh);
unregister();
```

The late sink receives future inspection events. It does not receive events emitted before registration. The hub isolates each sink failure from the actor and the other sinks.

Do not log secrets in state, events, or tracing attributes.

See [`inspection.ts`](../examples/core/src/inspection.ts).
