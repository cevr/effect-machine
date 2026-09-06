// @effect-diagnostics strictEffectProvide:off - tests are entry points
// @effect-diagnostics anyUnknownInErrorContext:off
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema, SubscriptionRef } from "effect";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

import { Event, Machine, State } from "../src/index.js";

const LifecycleState = State({ Active: {} });
const LifecycleEvent = Event({ Ping: {} });

describe("actor stop completion", () => {
  it.scopedLive("can stop after cancellation interrupts recovery self-stop", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<Effect.Effect<void>>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      });
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.await(stop).pipe(
                  Effect.flatMap((stopActor) => stopActor),
                  Effect.as(Option.none()),
                ),
            },
          },
        }),
      );
      yield* Deferred.succeed(stop, actor.stop);
      const starting = yield* actor.start.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(starting);
      const stopped = yield* actor.stop.pipe(Effect.exit);
      expect(stopped._tag).toBe("Success");
      expect(actor.client.getLifecycle()._tag).toBe("Stopped");
      yield* actor.stop;
      expect((yield* actor.awaitExit)._tag).toBe("Stopped");
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("waits for an uninterruptible self-stop recovery to finish", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<Effect.Effect<void>>();
      const stoppedInside = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let backgroundStarts = 0;
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.sync(() => {
          backgroundStarts++;
        }),
      );
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.await(stop).pipe(
                  Effect.flatMap((stopActor) => stopActor),
                  Effect.andThen(Deferred.succeed(stoppedInside, undefined)),
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some(LifecycleState.Active)),
                  Effect.uninterruptible,
                ),
            },
          },
        }),
      );
      yield* Deferred.succeed(stop, actor.stop);
      const starting = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(stoppedInside);
      const stopping = yield* actor.stop.pipe(Effect.forkScoped({ startImmediately: true }));
      const earlyExit = stopping.pollUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(stopping);
      expect(earlyExit).toBeUndefined();
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
      expect(backgroundStarts).toBe(0);
      expect((yield* actor.awaitExit)._tag).toBe("Stopped");
    }),
  );

  it.scopedLive("does not resume when recovery catches a self-stop cause", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<Effect.Effect<void>>();
      let backgroundStarts = 0;
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.sync(() => {
          backgroundStarts++;
        }),
      );
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.await(stop).pipe(
                  Effect.flatMap((stopActor) => stopActor),
                  Effect.as(Option.some(LifecycleState.Active)),
                  Effect.catchCause(() => Effect.succeedSome(LifecycleState.Active)),
                ),
            },
          },
        }),
      );
      yield* Deferred.succeed(stop, actor.stop);
      yield* actor.start.pipe(Effect.exit);
      yield* actor.awaitExit;
      expect(backgroundStarts).toBe(0);
    }),
  );

  it.scopedLive("keeps external stop callers waiting for self-stop recovery cleanup", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<Effect.Effect<void>>();
      const cleaning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      });
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.await(stop).pipe(
                  Effect.flatMap((stopActor) => stopActor),
                  Effect.as(Option.none()),
                  Effect.ensuring(
                    Deferred.succeed(cleaning, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                ),
            },
          },
        }),
      );
      yield* Deferred.succeed(stop, actor.stop);
      const starting = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      const stopping = yield* actor.stop.pipe(Effect.forkScoped({ startImmediately: true }));
      const earlyExit = stopping.pollUnsafe();
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(starting);
      yield* Fiber.join(stopping);
      expect(earlyExit).toBeUndefined();
      const terminal = yield* actor.awaitExit;
      expect(actor.client.getLifecycle()).toBe(terminal);
    }),
  );

  it.scopedLive("reports recovery cleanup defects on every stop", () =>
    Effect.gen(function* () {
      for (const selfStop of [false, true]) {
        const entered = yield* Deferred.make<void>();
        const stop = yield* Deferred.make<Effect.Effect<void>>();
        const machine = Machine.make({
          state: LifecycleState,
          event: LifecycleEvent,
          initial: LifecycleState.Active,
        });
        const actor = yield* Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(
                    Effect.suspend(() => {
                      if (selfStop)
                        return Deferred.await(stop).pipe(Effect.flatMap((stopActor) => stopActor));
                      return Effect.never;
                    }),
                  ),
                  Effect.andThen(Effect.never),
                  Effect.ensuring(Effect.die("recovery cleanup defect")),
                ),
            },
          },
        });
        yield* Deferred.succeed(stop, actor.stop);
        const starting = yield* actor.start.pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const first = yield* actor.stop.pipe(Effect.exit);
        const second = yield* actor.stop.pipe(Effect.exit);
        yield* Fiber.await(starting);
        expect(Exit.isFailure(first)).toBe(true);
        expect(Exit.isFailure(second)).toBe(true);
        if (Exit.isFailure(first))
          expect(Cause.pretty(first.cause)).toContain("recovery cleanup defect");
        if (Exit.isFailure(second))
          expect(Cause.pretty(second.cause)).toContain("recovery cleanup defect");
        const terminal = yield* actor.awaitExit;
        expect(terminal._tag).toBe("Defect");
        if (terminal._tag === "Defect") expect(terminal.phase).toBe("cleanup");
      }
    }),
  );

  it.scopedLive("reports Stopped when stop cancels an initial transition", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).immediate(LifecycleState.Active, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const actor = yield* Machine.scoped(Machine.spawn(machine));
      const starting = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* actor.stop;
      expect((yield* actor.awaitExit)._tag).toBe("Stopped");
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
    }),
  );

  it.scopedLive("waits for recovery cleanup after the stop caller is interrupted", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const cleaning = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      });
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Deferred.succeed(cleaning, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                    ),
                  ),
                ),
            },
          },
        }),
      );
      const starting = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const stopping = yield* actor.stop.pipe(Effect.forkScoped);
      yield* Deferred.await(cleaning);
      expect(stopping.pollUnsafe()).toBeUndefined();
      yield* Fiber.interrupt(stopping);
      expect(starting.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      yield* actor.stop;
      expect(Exit.hasInterrupts(yield* Fiber.await(starting))).toBe(true);
      expect(actor.client.getLifecycle()._tag).toBe("Stopped");
    }),
  );

  it.scopedLive("can stop itself from recovery without resuming startup", () =>
    Effect.gen(function* () {
      const stop = yield* Deferred.make<Effect.Effect<void>>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      });
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.await(stop).pipe(
                  Effect.flatMap((stopActor) => stopActor),
                  Effect.as(Option.some(LifecycleState.Active)),
                ),
            },
          },
        }),
      );
      yield* Deferred.succeed(stop, actor.stop);
      expect(Exit.hasInterrupts(yield* actor.start.pipe(Effect.exit))).toBe(true);
      const terminal = yield* actor.awaitExit;
      expect(actor.client.getLifecycle()).toBe(terminal);
      expect(actor.client.getLifecycle()._tag).toBe("Stopped");
    }),
  );

  it.scopedLive("does not resume startup after stop during recovery", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let started = 0;
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.sync(() => {
          started++;
        }),
      );
      const actor = yield* Machine.scoped(
        Machine.spawn(machine, {
          lifecycle: {
            recovery: {
              resolve: () =>
                Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(Option.some(LifecycleState.Active)),
                ),
            },
          },
        }),
      );
      const starting = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* actor.stop;
      const terminal = yield* actor.awaitExit;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(starting);
      expect(actor.client.getLifecycle()).toBe(terminal);
      expect(started).toBe(0);
    }),
  );

  it.scopedLive("stop returns with a terminal public lifecycle", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      });
      const actor = yield* Machine.scoped(Machine.spawn(machine));
      yield* actor.start;
      yield* actor.stop;
      expect((yield* actor.awaitExit)._tag).toBe("Stopped");
      expect((yield* SubscriptionRef.get(actor.lifecycle))._tag).toBe("Stopped");
    }),
  );

  it.scopedLive("awaitExit returns with the same final or defect lifecycle", () =>
    Effect.gen(function* () {
      const States = State({ Active: {}, Done: {} });
      const Events = Event({ Finish: {}, Fail: {} });
      const machine = Machine.make({ state: States, event: Events, initial: States.Active })
        .on(States.Active, Events.Finish, () => States.Done)
        .on(States.Active, Events.Fail, () => Effect.die(new Error("failed")))
        .final(States.Done);
      for (const event of [Events.Finish, Events.Fail]) {
        const actor = yield* Machine.scoped(Machine.spawn(machine));
        yield* actor.start;
        yield* actor.send(event);
        const exit = yield* actor.awaitExit;
        expect(yield* SubscriptionRef.get(actor.lifecycle)).toBe(exit);
        yield* actor.stop.pipe(Effect.exit);
        expect(yield* SubscriptionRef.get(actor.lifecycle)).toBe(exit);
      }
    }),
  );

  it.scopedLive("concurrent stops await background cleanup", () =>
    Effect.gen(function* () {
      const releaseBackground = yield* Deferred.make<void>();
      const stateCleaned = yield* Deferred.make<void>();
      const stateStarted = yield* Deferred.make<void>();
      const backgroundStarted = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      })
        .spawn(LifecycleState.Active, () =>
          Effect.addFinalizer(() => Deferred.succeed(stateCleaned, void 0)).pipe(
            Effect.andThen(Deferred.succeed(stateStarted, void 0)),
            Effect.andThen(Effect.never),
          ),
        )
        .background(() =>
          Effect.addFinalizer(() => Deferred.await(releaseBackground)).pipe(
            Effect.andThen(Deferred.succeed(backgroundStarted, void 0)),
            Effect.andThen(Effect.never),
          ),
        );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseBackground, void 0));
        yield* actor.start;
        yield* Deferred.await(stateStarted);
        yield* Deferred.await(backgroundStarted);

        const firstStop = yield* actor.stop.pipe(Effect.forkChild);
        yield* Deferred.await(stateCleaned);

        const secondStop = yield* actor.stop.pipe(Effect.forkChild);
        yield* yieldFibers;

        const firstBeforeCleanup = firstStop.pollUnsafe();
        const secondBeforeCleanup = secondStop.pollUnsafe();
        expect(firstBeforeCleanup).toBeUndefined();
        expect(secondBeforeCleanup).toBeUndefined();

        yield* Deferred.succeed(releaseBackground, void 0);
        const firstExit = yield* Fiber.await(firstStop);
        const secondExit = yield* Fiber.await(secondStop);
        expect(firstExit._tag).toBe("Success");
        expect(secondExit._tag).toBe("Success");
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
    }),
  );

  it.scopedLive("interrupted stop callers do not cancel the shutdown owner", () =>
    Effect.gen(function* () {
      const releaseBackground = yield* Deferred.make<void>();
      const backgroundStarted = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.addFinalizer(() =>
          Deferred.succeed(backgroundStarted, void 0).pipe(
            Effect.andThen(Deferred.await(releaseBackground)),
          ),
        ).pipe(Effect.andThen(Effect.never)),
      );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseBackground, void 0));
        yield* actor.start;
        const firstStop = yield* actor.stop.pipe(Effect.forkChild);
        yield* Deferred.await(backgroundStarted);
        const secondStop = yield* actor.stop.pipe(Effect.forkChild);
        yield* yieldFibers;

        const interruptSecond = yield* Fiber.interrupt(secondStop).pipe(Effect.forkChild);
        const interrupted = yield* Fiber.await(interruptSecond);
        expect(interrupted._tag).toBe("Success");
        const secondExit = yield* Fiber.await(secondStop);
        expect(secondExit._tag).toBe("Failure");
        if (secondExit._tag === "Failure") {
          expect(Cause.hasInterruptsOnly(secondExit.cause)).toBe(true);
        }
        const actorExit = yield* actor.awaitExit.pipe(Effect.forkChild);
        yield* yieldFibers;
        expect(actorExit.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(releaseBackground, void 0);
        const firstExit = yield* Fiber.await(firstStop);
        expect(firstExit._tag).toBe("Success");
        const terminalExit = yield* Fiber.await(actorExit);
        expect(terminalExit._tag).toBe("Success");
        if (terminalExit._tag === "Success") expect(terminalExit.value._tag).toBe("Stopped");
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
    }),
  );

  it.scopedLive("awaitExit waits for natural final cleanup", () =>
    Effect.gen(function* () {
      const backgroundStarted = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const FinalState = State({ Active: {}, Done: {} });
      const FinalEvent = Event({ Finish: {} });
      const machine = Machine.make({
        state: FinalState,
        event: FinalEvent,
        initial: FinalState.Active,
      })
        .on(FinalState.Active, FinalEvent.Finish, () => FinalState.Done)
        .final(FinalState.Done)
        .background(() =>
          Effect.addFinalizer(() =>
            Deferred.succeed(cleanupStarted, void 0).pipe(
              Effect.andThen(Deferred.await(releaseCleanup)),
            ),
          ).pipe(
            Effect.andThen(Deferred.succeed(backgroundStarted, void 0)),
            Effect.andThen(Effect.never),
          ),
        );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseCleanup, void 0));
        yield* actor.start;
        yield* Deferred.await(backgroundStarted);
        yield* actor.send(FinalEvent.Finish);
        yield* actor.awaitFinal;
        const pendingExit = yield* actor.awaitExit.pipe(Effect.forkChild);
        const stop = yield* actor.stop.pipe(Effect.forkChild);
        yield* Deferred.await(cleanupStarted);
        yield* yieldFibers;
        expect(pendingExit.pollUnsafe()).toBeUndefined();
        expect(stop.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseCleanup, void 0);
        const exit = yield* Fiber.await(pendingExit);
        expect(exit._tag).toBe("Success");
        const stopped = yield* Fiber.await(stop);
        expect(stopped._tag).toBe("Success");
        if (exit._tag === "Success") expect(exit.value._tag).toBe("Final");
        yield* Deferred.await(cleanupStarted);
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
    }),
  );

  it.scopedLive("settles pending asks before stop completes", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.String) });
      const replyStarted = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, () =>
          Deferred.succeed(replyStarted, void 0).pipe(Effect.andThen(Effect.never)),
        );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        const pending = yield* actor.ask(ReplyEvent.Request).pipe(Effect.forkChild);
        yield* Deferred.await(replyStarted);
        yield* actor.stop;
        const pendingExit = yield* Fiber.await(pending).pipe(
          Effect.timeout("1 second"),
          Effect.exit,
        );
        expect(pendingExit._tag).toBe("Success");
        if (pendingExit._tag === "Success") {
          expect(pendingExit.value._tag).toBe("Failure");
          if (pendingExit.value._tag === "Failure") {
            const error = Cause.findErrorOption(pendingExit.value.cause);
            expect(Option.isSome(error)).toBe(true);
            if (Option.isSome(error)) expect(error.value._tag).toBe("ActorStoppedError");
          }
        }
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
    }),
  );

  it.scopedLive("reports cleanup defects on every stop", () =>
    Effect.gen(function* () {
      const backgroundStarted = yield* Deferred.make<void>();
      const DefectState = State({ Active: {} });
      const DefectEvent = Event({ Ping: {} });
      let bodyCompleted = false;
      let firstStopFailed = false;
      let actorExitWasCleanupDefect = false;
      let secondStopFailed = false;
      const machine = Machine.make({
        state: DefectState,
        event: DefectEvent,
        initial: DefectState.Active,
      }).background(() =>
        Effect.addFinalizer(() => Effect.die("background cleanup defect")).pipe(
          Effect.andThen(Deferred.succeed(backgroundStarted, void 0)),
          Effect.andThen(Effect.never),
        ),
      );
      const result = yield* Effect.scoped(
        Machine.scoped(
          Effect.gen(function* () {
            const actor = yield* Machine.spawn(machine);
            yield* actor.start;
            yield* Deferred.await(backgroundStarted);

            const firstStop = yield* actor.stop.pipe(Effect.exit);
            firstStopFailed = firstStop._tag === "Failure";
            const actorExit = yield* actor.awaitExit.pipe(Effect.timeout("1 second"), Effect.exit);
            if (actorExit._tag === "Success" && actorExit.value._tag === "Defect") {
              actorExitWasCleanupDefect = actorExit.value.phase === "cleanup";
            }

            const secondStop = yield* actor.stop.pipe(Effect.exit);
            secondStopFailed = secondStop._tag === "Failure";
            yield* Effect.sync(() => {
              bodyCompleted = true;
            });
          }).pipe(Effect.timeout("2 seconds")),
        ),
      ).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(bodyCompleted).toBe(true);
      expect(firstStopFailed).toBe(true);
      expect(actorExitWasCleanupDefect).toBe(true);
      expect(secondStopFailed).toBe(true);
    }),
  );

  it.scopedLive("Machine.scoped waits for actor cleanup", () =>
    Effect.gen(function* () {
      const backgroundStarted = yield* Deferred.make<void>();
      const releaseCleanup = yield* Deferred.make<void>();
      const cleaned = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.addFinalizer(() =>
          Deferred.await(releaseCleanup).pipe(Effect.andThen(Deferred.succeed(cleaned, void 0))),
        ).pipe(
          Effect.andThen(Deferred.succeed(backgroundStarted, void 0)),
          Effect.andThen(Effect.never),
        ),
      );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseCleanup, void 0));
        yield* actor.start;
        yield* Deferred.await(backgroundStarted);
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
      const cleanupExit = yield* Deferred.await(cleaned).pipe(
        Effect.timeout("1 second"),
        Effect.exit,
      );
      expect(cleanupExit._tag).toBe("Success");
    }),
  );

  it.scopedLive("stop waits for children in the implicit system scope", () =>
    Effect.gen(function* () {
      const childStarted = yield* Deferred.make<void>();
      const childCleanupStarted = yield* Deferred.make<void>();
      const releaseChild = yield* Deferred.make<void>();
      const childCleaned = yield* Deferred.make<void>();
      const childMachine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(() =>
        Effect.addFinalizer(() =>
          Deferred.succeed(childCleanupStarted, void 0).pipe(
            Effect.andThen(Deferred.await(releaseChild)),
            Effect.andThen(Deferred.succeed(childCleaned, void 0)),
          ),
        ).pipe(
          Effect.andThen(Deferred.succeed(childStarted, void 0)),
          Effect.andThen(Effect.never),
        ),
      );
      const parentMachine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Active,
      }).background(({ self }) =>
        self
          .spawn("worker", childMachine)
          .pipe(Effect.asVoid, Effect.orDie, Effect.andThen(Effect.never)),
      );
      const body = Effect.gen(function* () {
        const actor = yield* Machine.spawn(parentMachine);
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseChild, void 0));
        yield* actor.start;
        yield* Deferred.await(childStarted);
        const stop = yield* actor.stop.pipe(Effect.forkChild);
        yield* Deferred.await(childCleanupStarted);
        yield* yieldFibers;
        expect(stop.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseChild, void 0);
        const stopped = yield* Fiber.await(stop);
        expect(stopped._tag).toBe("Success");
        const cleaned = yield* Deferred.await(childCleaned).pipe(Effect.exit);
        expect(cleaned._tag).toBe("Success");
      }).pipe(Effect.timeout("2 seconds"));

      yield* Effect.scoped(Machine.scoped(body));
    }),
  );

  it.scopedLive("settles awaitExit when final output defects", () =>
    Effect.gen(function* () {
      const OutputState = State({ Done: {} });
      const OutputEvent = Event({ Ping: {} });
      const machine = Machine.make({
        state: OutputState,
        event: OutputEvent,
        initial: OutputState.Done,
      }).final(OutputState.Done, () => {
        // eslint-disable-next-line effect/noThrowStatement, effect/noNewError -- this fixture proves that a throwing final output settles shutdown.
        throw new Error("final output failed");
      });
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const exit = yield* actor.awaitExit.pipe(Effect.timeout("1 second"), Effect.exit);
      expect(exit._tag).toBe("Success");
      if (exit._tag === "Success") {
        expect(exit.value._tag).toBe("Defect");
        if (exit.value._tag === "Defect") expect(exit.value.phase).toBe("cleanup");
      }
      const stop = yield* actor.stop.pipe(Effect.timeout("1 second"), Effect.exit);
      expect(stop._tag).toBe("Failure");
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("settles repeated start after initial cleanup defect", () =>
    Effect.gen(function* () {
      const StartState = State({ Active: {} });
      const StartEvent = Event({ Ping: {} });
      let bodyCompleted = false;
      let firstStartFailed = false;
      let secondStartSettled = false;
      let actorExitWasCleanupDefect = false;
      const machine = Machine.make({
        state: StartState,
        event: StartEvent,
        initial: StartState.Active,
      }).spawn(StartState.Active, () =>
        Effect.acquireRelease(Effect.void, () => Effect.die("initial cleanup defect")).pipe(
          Effect.andThen(Effect.die("initial spawn defect")),
        ),
      );
      const result = yield* Effect.scoped(
        Machine.scoped(
          Effect.gen(function* () {
            const actor = yield* Machine.spawn(machine);
            const firstStart = yield* actor.start.pipe(Effect.exit);
            firstStartFailed = firstStart._tag === "Failure";
            if (firstStart._tag === "Failure") {
              expect(Cause.hasDies(firstStart.cause)).toBe(true);
            }

            const secondStart = yield* actor.start.pipe(Effect.timeout("1 second"), Effect.exit);
            secondStartSettled = true;
            expect(secondStart._tag).toBe("Failure");
            if (secondStart._tag === "Failure") {
              expect(Cause.hasDies(secondStart.cause)).toBe(true);
            }

            const actorExit = yield* actor.awaitExit.pipe(Effect.timeout("1 second"), Effect.exit);
            if (actorExit._tag === "Success" && actorExit.value._tag === "Defect") {
              actorExitWasCleanupDefect = actorExit.value.phase === "cleanup";
            }
            bodyCompleted = true;
          }).pipe(Effect.timeout("2 seconds")),
        ),
      ).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
      expect(bodyCompleted).toBe(true);
      expect(firstStartFailed).toBe(true);
      expect(secondStartSettled).toBe(true);
      expect(actorExitWasCleanupDefect).toBe(true);
    }),
  );
});
