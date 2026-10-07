# Persistence and supervision

## Recovery

Recovery resolves the initial state during `actor.start`.

```ts
recovery: {
  resolve: ({ actorId, generation, machineInitial }) => storage.load(actorId),
}
```

Return `Option.some(state)` to recover a state. Return `Option.none()` to use the machine initial state. The `generation` is zero on cold start and increases after each supervised restart.

The `hydrate` spawn option takes priority over recovery.

## Durability

Durability runs after a committed transition:

```ts
durability: {
  save: ({ actorId, previousState, nextState, event }) =>
    storage.save(actorId, nextState),
  shouldSave: (state, previous) => state._tag !== previous._tag,
}
```

`call` settles after durability completes. Use `send` when the sender does not need commit acknowledgement.

The lifecycle interface does not define a persistence backend. Build the backend as an Effect service at the application boundary. Capture the service implementation when you build the actor options.

See [`persistence.ts`](../examples/core/src/persistence.ts).

## Supervision

Supervision restarts an actor after a defect:

```ts
Machine.spawn(machine, {
  supervision: Supervision.restart({ maxRestarts: 3, within: "1 minute" }),
});
```

- A restart uses `machine.initial` or recovery. It does not use the last in-memory state.
- The actor ID stays the same.
- Pending calls and asks fail with `ActorStoppedError`.
- State-owned and actor-owned child actors stop.
- Final state, `stop`, and `drain` are terminal.
- Schedule exhaustion produces `ActorExit.Defect`.

See [`supervision.ts`](../examples/core/src/supervision.ts).

## Error reporting

The actor lifecycle reports contained failures to Effect `ErrorReporter`s. Register the reporters in the context that spawns the actor:

```ts
Machine.spawn(machine).pipe(Effect.provide(ErrorReporter.layer([reporter])));
```

- Each generation reports its complete defect once, when it closes. The cause includes transition, spawn, task, background, and cleanup failures of that generation.
- Each supervised restart reports its own generation. A restart step that fails before a new generation exists reports with phase `restart`.
- A final output defect reports once when the actor completes.
- Child actors report their own failures. They capture the reporters of the parent handler that spawned them.
- Normal stops, final states, and pure interruption do not report.
- The actor keeps the reporters that it captured at spawn. A later `start` or `stop` caller cannot add or replace them.
- Each report annotates the reporting fiber with `effect_machine.actor.id`, `effect_machine.actor.generation`, and `effect_machine.defect.phase`. Reporters read them from `References.CurrentLogAnnotations`.
- A failure that also reaches a caller can report again at the caller's boundary. Use `ErrorReporter.make`. It skips a cause or error object that it already reported.
- A reporter that throws does not change the actor exit.

Inspection `@machine.error` events stay diagnostics. They do not replace reporting.

## Local and cluster durability

Local actors use lifecycle hooks. Entity machines use the cluster persistence adapter.

- Snapshot strategy saves periodic state and a deactivation snapshot.
- Journal strategy appends accepted events and replays the journal on activation.

Keep the two ownership models separate. A local actor must not also assume that cluster entity persistence owns its commit.
