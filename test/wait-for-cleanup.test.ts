import { Deferred, Effect, Exit, Fiber, Option, Queue, Scheduler, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";

import type { ActorStoppedError } from "../src/index.js";
import { ActorSystemDefault, Event, Machine, State } from "../src/index.js";
import { trackRegistrations } from "./wait-registrations.js";

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

const spawnStarted = Effect.gen(function* () {
  const actor = yield* Machine.spawn(machine);
  yield* actor.start;
  return actor;
});
type TestActor = Effect.Success<typeof spawnStarted>;

/** Moves the wait's yield points: a smaller budget, or one forced yield at an operation. */
interface Schedule {
  readonly name: string;
  readonly apply: <A, E>(wait: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}
const budget = (operations: number): Schedule => ({
  name: `budget ${operations}`,
  apply: (wait) => Effect.provideService(wait, Scheduler.MaxOpsBeforeYield, operations),
});
const yieldAt = (offset: number): Schedule => ({
  name: `yield at ${offset}`,
  apply: (wait) =>
    Effect.flatMap(Effect.service(Scheduler.Scheduler), (base) => {
      let operations = 0;
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        shouldYield: () => {
          operations += 1;
          return operations === offset + 1;
        },
        makeDispatcher: () => base.makeDispatcher(),
      };
      return Effect.provideService(wait, Scheduler.Scheduler, scheduler);
    }),
});
const schedules: ReadonlyArray<Schedule> = [
  ...Array.from({ length: 62 }, (_, index) => budget(index + 3)),
  ...Array.from({ length: 301 }, (_, index) => yieldAt(index)),
];
// Each wait never matches while the actor runs, so it subscribes, judges and sleeps.
const sleepingForms: ReadonlyArray<
  readonly [string, (actor: TestActor) => Effect.Effect<unknown, ActorStoppedError>]
> = [
  ["waitFor", (actor) => actor.waitFor(() => false)],
  ["awaitFinal", (actor) => actor.awaitFinal],
  ["sendAndWait", (actor) => actor.sendAndWait(TestEvent.Probe, () => false)],
];

describe("wait registration lifetime", () => {
  it.live("the registration count fails for a state ref that no actor owns", () =>
    Effect.gen(function* () {
      const foreign = yield* SubscriptionRef.make<string>("foreign");
      expect(() => trackRegistrations(foreign)()).toThrow("No actor owns this state ref");
    }),
  );

  it.live(
    "an interrupt at any point of a wait releases every registration (R1-M1, red on 1469452)",
    () =>
      Effect.gen(function* () {
        const failures: Array<string> = [];
        for (const [formName, form] of sleepingForms) {
          for (const schedule of schedules) {
            const actor = yield* spawnStarted;
            const registrations = trackRegistrations(actor.state);
            const baseline = registrations();
            // The wait runs until the schedule yields, and the interrupt lands there.
            const waiting = yield* form(actor).pipe(
              schedule.apply,
              Effect.forkDetach({ startImmediately: true }),
            );
            const interrupted = yield* Fiber.interrupt(waiting).pipe(
              Effect.timeoutOption("1 second"),
            );
            const held = registrations() - baseline;
            if (Option.isNone(interrupted)) failures.push(`${formName} ${schedule.name}: hang`);
            else if (held !== 0) failures.push(`${formName} ${schedule.name}: +${held}`);
            yield* actor.stop;
          }
        }
        expect(failures).toEqual([]);
      }).pipe(Effect.provide(ActorSystemDefault)),
    120_000,
  );

  it.live("waits that sleep and then match release every registration while the actor runs", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(toggleMachine);
      yield* actor.start;
      const registrations = trackRegistrations(actor.state);
      const baseline = registrations();
      let target: "On" | "Off" = "Off";
      for (let round = 0; round < 500; round += 1) {
        if (target === "Off") target = "On";
        else target = "Off";
        const judged = Deferred.makeUnsafe<void>();
        const waiting = yield* actor
          .waitFor((state) => {
            Deferred.doneUnsafe(judged, Exit.void);
            return state._tag === target;
          })
          .pipe(Effect.forkDetach);
        // The snapshot does not match, so the wait sleeps until the toggle's write.
        yield* Deferred.await(judged);
        yield* actor.send(ToggleEvent.Toggle);
        expect((yield* Fiber.join(waiting))._tag).toBe(target);
      }
      const held = registrations() - baseline;
      yield* actor.stop;
      expect(held).toBe(0);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.live("interrupted sleeping waits release every registration while the actor runs", () =>
    Effect.gen(function* () {
      const actor = yield* spawnStarted;
      const registrations = trackRegistrations(actor.state);
      const baseline = registrations();
      for (let round = 0; round < 500; round += 1) {
        const judged = Deferred.makeUnsafe<void>();
        const waiting = yield* actor
          .waitFor(() => {
            Deferred.doneUnsafe(judged, Exit.void);
            return false;
          })
          .pipe(Effect.forkDetach);
        yield* Deferred.await(judged);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiting);
      }
      const held = registrations() - baseline;
      yield* actor.stop;
      expect(held).toBe(0);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

const ToggleState = State({ Off: {}, On: {} });
const ToggleEvent = Event({ Toggle: {} });
const toggleMachine = Machine.make({
  state: ToggleState,
  event: ToggleEvent,
  initial: ToggleState.Off,
})
  .on(ToggleState.Off, ToggleEvent.Toggle, () => ToggleState.On)
  .on(ToggleState.On, ToggleEvent.Toggle, () => ToggleState.Off);
