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
- accepted transition
- state-owned Effect start
- named task start, success, failure, and interruption
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

The console inspector logs readable machine events with Effect logging. The tracing inspector emits spans and events. The collecting inspector stores typed events for tests. `combineInspectors` isolates an inspector failure from the other inspectors.

Do not log secrets in state, events, or tracing attributes.

See [`inspection.ts`](../examples/core/src/inspection.ts).
