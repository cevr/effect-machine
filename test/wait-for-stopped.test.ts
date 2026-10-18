// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Effect, Exit, Fiber, Option, Queue, Stream, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { ActorStoppedError, ActorSystemDefault, Event, Machine, State } from "../src/index.js";

const WaitState = State({ Idle: {}, Working: {}, Other: {}, Done: {} });
type WaitState = typeof WaitState.Type;
const WaitEvent = Event({ Work: {}, Next: {}, Finish: {}, Crash: {} });

// Builder methods mutate the machine, so each variant builds its own.
const makeMachine = () =>
  Machine.make({ state: WaitState, event: WaitEvent, initial: WaitState.Idle })
    .on(WaitState.Idle, WaitEvent.Work, () => WaitState.Working)
    .on(WaitState.Working, WaitEvent.Next, () => WaitState.Other)
    .on([WaitState.Idle, WaitState.Working], WaitEvent.Finish, () => WaitState.Done)
    .on([WaitState.Idle, WaitState.Working], WaitEvent.Crash, () => Effect.die("boom"))
    .final(WaitState.Done);
const machine = makeMachine();

const spawnStarted = Effect.gen(function* () {
  const actor = yield* Machine.spawn(machine);
  yield* actor.start;
  yield* Effect.addFinalizer(() => actor.stop);
  return actor;
});

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type WaitRef = Effect.Success<typeof spawnStarted>;
type StoppedErrorOf<F extends (ref: WaitRef) => Effect.Effect<unknown, unknown>> = Exact<
  Effect.Error<ReturnType<F>>,
  ActorStoppedError
>;
const waitForVariant = (ref: WaitRef) => ref.waitFor(WaitState.Done);
const waitForPredicate = (ref: WaitRef) => ref.waitFor((state) => state._tag === "Done");
const awaitFinal = (ref: WaitRef) => ref.awaitFinal;
const sendAndWaitVariant = (ref: WaitRef) => ref.sendAndWait(WaitEvent.Work, WaitState.Working);
const sendAndWaitPredicate = (ref: WaitRef) =>
  ref.sendAndWait(WaitEvent.Work, (state) => state._tag === "Working");
const sendAndWaitFinal = (ref: WaitRef) => ref.sendAndWait(WaitEvent.Finish);
const _waitForVariantError: StoppedErrorOf<typeof waitForVariant> = true;
const _waitForPredicateError: StoppedErrorOf<typeof waitForPredicate> = true;
const _awaitFinalError: StoppedErrorOf<typeof awaitFinal> = true;
const _sendAndWaitVariantError: StoppedErrorOf<typeof sendAndWaitVariant> = true;
const _sendAndWaitPredicateError: StoppedErrorOf<typeof sendAndWaitPredicate> = true;
const _sendAndWaitFinalError: StoppedErrorOf<typeof sendAndWaitFinal> = true;

// The time limit only makes a hang visible as a test failure; the waits under test have none.
const settled = <A, E>(wait: Effect.Effect<A, E>) =>
  wait.pipe(Effect.timeout("2 seconds"), Effect.exit);

const expectStopped = (exit: Exit.Exit<unknown, unknown>, actorId: string): void => {
  expect(Exit.findErrorOption(exit)).toEqual(Option.some(ActorStoppedError.make({ actorId })));
};

/** Fork a predicate wait and return once its listener is registered. */
const forkSubscribedWait = (actor: WaitRef, predicate: (state: WaitState) => boolean) =>
  Effect.gen(function* () {
    const observations = yield* Queue.unbounded<WaitState>();
    const fiber = yield* actor
      .waitFor((state) => {
        Queue.offerUnsafe(observations, state);
        return predicate(state);
      })
      .pipe(settled, Effect.forkScoped);
    yield* Queue.take(observations);
    return fiber;
  });

// The scheduling windows around a wait's start and its observation order are owned by the
// property in wait-order.test.ts.
describe("waits end when the actor stops", () => {
  it.scopedLive("fails a wait that starts after the actor stopped", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      yield* actor.stop;
      expectStopped(yield* settled(actor.waitFor(WaitState.Done)), actor.id);
      expectStopped(yield* settled(actor.awaitFinal), actor.id);
      expectStopped(yield* settled(actor.sendAndWait(WaitEvent.Work, WaitState.Working)), actor.id);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("succeeds after a stop when the last state matches", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      yield* actor.call(WaitEvent.Work);
      yield* actor.stop;
      expect(yield* actor.waitFor(WaitState.Working)).toEqual(WaitState.Working);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("fails a waiting call when the actor stops", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Done");
      yield* actor.stop;
      expectStopped(yield* Fiber.join(waiting), actor.id);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("fails a waiting call when the actor defects", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Working");
      yield* actor.send(WaitEvent.Crash);
      expectStopped(yield* Fiber.join(waiting), actor.id);
      expect((yield* actor.awaitExit)._tag).toBe("Defect");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("fails a waiting call when the actor reaches a non-matching final state", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Other");
      yield* actor.send(WaitEvent.Finish);
      expectStopped(yield* Fiber.join(waiting), actor.id);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps a match that happened before the stop", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Working");
      yield* actor.call(WaitEvent.Work);
      yield* actor.call(WaitEvent.Finish);
      yield* actor.stop;
      const exit = yield* Fiber.join(waiting);
      expect(exit).toEqual(Exit.succeed(WaitState.Working));
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps a match whose notification a stop overtakes", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const release = yield* Deferred.make<void>();
      const holding = yield* Deferred.make<void>();
      // The loop writes the state, then blocks on this permit before it notifies listeners.
      yield* SubscriptionRef.updateEffect(actor.latestTransition, (current) =>
        Deferred.succeed(holding, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(current),
        ),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(holding);
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Working");
      yield* actor.send(WaitEvent.Work);
      yield* SubscriptionRef.changes(actor.state).pipe(
        Stream.filter((state) => state._tag === "Working"),
        Stream.runHead,
      );
      const stopping = yield* actor.stop.pipe(Effect.forkScoped);
      const exit = yield* Fiber.join(waiting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect(exit).toEqual(Exit.succeed(WaitState.Working));
      expect((yield* actor.awaitExit)._tag).toBe("Stopped");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps a match whose entry defects before the notification", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(
        makeMachine().spawn(WaitState.Working, () => Effect.die("entry failed")),
      );
      yield* actor.start;
      yield* Effect.addFinalizer(() => actor.stop);
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Working");
      yield* actor.send(WaitEvent.Work);
      expect(yield* Fiber.join(waiting)).toEqual(Exit.succeed(WaitState.Working));
      expect((yield* actor.awaitExit)._tag).toBe("Defect");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("sees a recovered state that matches", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        lifecycle: {
          recovery: { resolve: () => Effect.succeedSome(WaitState.Working) },
        },
      });
      yield* Effect.addFinalizer(() => actor.stop);
      const waiting = yield* forkSubscribedWait(actor, (state) => state._tag === "Working");
      yield* actor.start;
      expect(yield* Fiber.join(waiting)).toEqual(Exit.succeed(WaitState.Working));
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("stops observing after the waiter is interrupted", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      let observations = 0;
      const subscribed = yield* Queue.unbounded<void>();
      const waiting = yield* actor
        .waitFor(() => {
          observations += 1;
          Queue.offerUnsafe(subscribed, undefined);
          return false;
        })
        .pipe(Effect.forkScoped);
      yield* Queue.take(subscribed);
      yield* Fiber.interrupt(waiting);
      const before = observations;
      yield* actor.call(WaitEvent.Work);
      yield* actor.stop;
      expect(observations).toBe(before);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("fails awaitFinal when the actor stops or defects", () =>
    Effect.gen(function* () {
      const stopped = yield* spawnStarted;
      const stopping = yield* settled(stopped.awaitFinal).pipe(Effect.forkScoped);
      yield* stopped.call(WaitEvent.Work);
      yield* stopped.stop;
      expectStopped(yield* Fiber.join(stopping), stopped.id);

      const crashed = yield* spawnStarted;
      const crashing = yield* settled(crashed.awaitFinal).pipe(Effect.forkScoped);
      yield* crashed.call(WaitEvent.Work);
      yield* crashed.send(WaitEvent.Crash);
      expectStopped(yield* Fiber.join(crashing), crashed.id);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive(
    "fails sendAndWait when its event defects or reaches a non-matching final state",
    () =>
      Effect.gen(function* () {
        const crashed = yield* spawnStarted;
        expectStopped(yield* settled(crashed.sendAndWait(WaitEvent.Crash)), crashed.id);

        const finished = yield* spawnStarted;
        expectStopped(
          yield* settled(finished.sendAndWait(WaitEvent.Finish, WaitState.Other)),
          finished.id,
        );

        const matched = yield* spawnStarted;
        expect(yield* matched.sendAndWait(WaitEvent.Finish)).toEqual(WaitState.Done);
      }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
