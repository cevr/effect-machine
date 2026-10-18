import { Effect, Exit, Fiber, Queue } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { ActorSystemDefault, Event, Machine, State } from "../src/index.js";

const TestState = State({ Idle: {}, Done: {} });
// `Probe` has no transition: a `call` with it returns after every event queued before it.
const TestEvent = Event({ Finish: {}, Probe: {} });
const machine = Machine.make({ state: TestState, event: TestEvent, initial: TestState.Idle })
  .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
  .final(TestState.Done);

describe("waitFor listener lifetime", () => {
  it.scopedLive("stops calling a cancelled wait predicate", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* Effect.addFinalizer(() => actor.stop);
      const observations = yield* Queue.unbounded<string>();
      const observed: string[] = [];
      const waiting = yield* actor
        .waitFor((state) => {
          observed.push(state._tag);
          Queue.offerUnsafe(observations, state._tag);
          return false;
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(observations);
      yield* Fiber.interrupt(waiting);
      expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
      const before = observed.length;
      yield* actor.call(TestEvent.Finish);
      expect((yield* actor.snapshot)._tag).toBe("Done");
      expect(observed).toHaveLength(before);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("stops observing when the snapshot predicate defects", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* Effect.addFinalizer(() => actor.stop);
      let observations = 0;
      const failure = yield* actor
        .waitFor(() => {
          observations += 1;
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Exercise a defect from the synchronous public predicate.
          if (observations === 1) throw new Error("predicate failed");
          return false;
        })
        .pipe(Effect.exit);
      expect(Exit.hasDies(failure)).toBe(true);
      const before = observations;
      yield* actor.call(TestEvent.Finish);
      expect((yield* actor.snapshot)._tag).toBe("Done");
      expect(observations).toBe(before);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("ends the wait when the predicate defects on a later state", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* Effect.addFinalizer(() => actor.stop);
      const observations = yield* Queue.unbounded<string>();
      const observed: string[] = [];
      const waiting = yield* actor
        .waitFor((state) => {
          observed.push(state._tag);
          Queue.offerUnsafe(observations, state._tag);
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Exercise a defect from the synchronous public predicate.
          if (state._tag === "Done") throw new Error("predicate failed");
          return false;
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Queue.take(observations);
      yield* actor.send(TestEvent.Finish);
      expect(Exit.hasDies(yield* Fiber.join(waiting))).toBe(true);
      expect(observed).toEqual(["Idle", "Done"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("sendAndWait does not send when the predicate defects on the snapshot", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* Effect.addFinalizer(() => actor.stop);
      const failure = yield* actor
        .sendAndWait(TestEvent.Finish, () => {
          // oxlint-disable-next-line effect/noThrowStatement, effect/noNewError -- Exercise a defect from the synchronous public predicate.
          throw new Error("predicate failed");
        })
        .pipe(Effect.exit);
      expect(Exit.hasDies(failure)).toBe(true);
      yield* actor.call(TestEvent.Probe);
      expect((yield* actor.snapshot)._tag).toBe("Idle");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
