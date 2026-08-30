import { Context, Effect, Ref } from "effect";
import { Event, Machine, State, Supervision } from "effect-machine";

class AttemptCounter extends Context.Service<
  AttemptCounter,
  { readonly next: Effect.Effect<number> }
>()("effect-machine/examples/AttemptCounter") {}

const WorkerState = State({ Running: {}, Done: {} });
const WorkerEvent = Event({ Complete: {} });

const workerMachine = Machine.make({
  state: WorkerState,
  event: WorkerEvent,
  initial: WorkerState.Running,
})
  .spawn(WorkerState.Running, ({ self }) =>
    Effect.gen(function* () {
      const attempts = yield* AttemptCounter;
      const attempt = yield* attempts.next;
      if (attempt === 1) return yield* Effect.die("first attempt failed");
      yield* self.send(WorkerEvent.Complete);
    }),
  )
  .on(WorkerState.Running, WorkerEvent.Complete, () => WorkerState.Done)
  .final(WorkerState.Done, () => "recovered");

export const supervisionProgram = Effect.gen(function* () {
  const attempts = yield* Ref.make(0);
  return yield* Machine.run(workerMachine, {
    supervision: Supervision.restart({ maxRestarts: 1 }),
  }).pipe(
    Effect.provideService(AttemptCounter, {
      next: Ref.updateAndGet(attempts, (value) => value + 1),
    }),
  );
});
