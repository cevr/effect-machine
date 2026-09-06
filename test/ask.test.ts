// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Cause, Deferred, Effect, Fiber, Option, Schema } from "effect";

import { Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const TestState = State({
  Idle: {},
  Active: { count: Schema.Finite },
  Done: {},
});

const TestEvent = Event({
  Start: {},
  Increment: {},
  GetCount: Event.reply({}, Schema.Finite),
  MultiplyCount: Event.reply({ factor: Schema.Finite }, Schema.Finite),
  GetNothing: Event.reply({}, Schema.Undefined),
  Stop: {},
});

const createMachine = () =>
  Machine.make({
    state: TestState,
    event: TestEvent,
    initial: TestState.Idle,
  })
    .on(TestState.Idle, TestEvent.Start, () => TestState.Active({ count: 0 }))
    .on(TestState.Active, TestEvent.Increment, ({ state }) =>
      TestState.Active({ count: state.count + 1 }),
    )
    // Handler that returns Machine.reply — typed domain reply for ask
    .on(TestState.Active, TestEvent.GetCount, ({ state }) =>
      Machine.reply(TestState.Active({ count: state.count }), state.count),
    )
    .on(TestState.Active, TestEvent.MultiplyCount, ({ state, event }) =>
      Machine.reply(TestState.Active({ count: state.count }), state.count * event.factor),
    )
    // Handler that returns Machine.reply with undefined — explicit undefined reply
    .on(TestState.Active, TestEvent.GetNothing, ({ state }) =>
      Machine.reply(TestState.Active({ count: state.count }), undefined),
    )
    .on(TestState.Active, TestEvent.Stop, () => TestState.Done)
    .final(TestState.Done);

describe("ActorRef.ask", () => {
  it.scopedLive("returns domain reply value from handler", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(TestEvent.Start);
      yield* actor.call(TestEvent.Increment);
      yield* actor.call(TestEvent.Increment);

      const count = yield* actor.ask(TestEvent.GetCount);
      expect(count).toBe(2);
    }),
  );

  it.scopedLive("fails with NoReplyError when no handler matches", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      // In Idle state — no handler for GetCount, so ask fails with NoReplyError
      const result = yield* actor.ask(TestEvent.GetCount).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.scopedLive("fails with ActorStoppedError on stopped actor", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.stop;

      const result = yield* actor.ask(TestEvent.GetCount).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.scopedLive("call still returns ProcessEventResult (unchanged)", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(TestEvent.Start);
      yield* actor.call(TestEvent.Increment);
      yield* actor.call(TestEvent.Increment);

      // call on GetCount handler returns ProcessEventResult, not the reply value
      const result = yield* actor.call(TestEvent.GetCount);
      expect(result.transitioned).toBe(true);
      expect(result.newState._tag).toBe("Active");
      // The reply field is on the result for inspection but call returns the full result
      expect(result.reply).toBe(2);
    }),
  );

  it.scopedLive("ask works with multiple sequential calls", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(TestEvent.Start);

      yield* actor.call(TestEvent.Increment);
      const count1 = yield* actor.ask(TestEvent.GetCount);
      expect(count1).toBe(1);

      yield* actor.call(TestEvent.Increment);
      const count2 = yield* actor.ask(TestEvent.GetCount);
      expect(count2).toBe(2);
    }),
  );

  it.scopedLive("reply-bearing events with payload accept plain constructor args", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(TestEvent.Start);
      yield* actor.call(TestEvent.Increment);
      yield* actor.call(TestEvent.Increment);

      const result = yield* actor.ask(TestEvent.MultiplyCount({ factor: 3 }));
      expect(result).toBe(6);
    }),
  );

  it.scopedLive("reply: undefined is a valid reply, not NoReplyError", () =>
    Effect.gen(function* () {
      const machine = createMachine();
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(TestEvent.Start);

      const result = yield* actor.ask(TestEvent.GetNothing);
      expect(result).toBeUndefined();
    }),
  );

  it.scopedLive("reply schema mismatch is a defect (die)", () =>
    Effect.gen(function* () {
      // Build a machine where the handler lies about the reply type
      const BadEvent = Event({
        GetCount: Event.reply({}, Schema.Finite),
      });

      const machine = Machine.make({
        state: TestState,
        event: BadEvent,
        initial: TestState.Idle,
      }).on(TestState.Idle, BadEvent.GetCount, () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional mismatch
        Machine.reply(TestState.Idle, "not-a-number" as any),
      );

      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const exit = yield* actor.ask(BadEvent.GetCount).pipe(Effect.exit);
      // Decode failure surfaces as a defect (die), not a checked error
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      const actorExit = yield* actor.awaitExit.pipe(Effect.timeout("1 second"), Effect.exit);
      expect(actorExit._tag).toBe("Success");
      if (actorExit._tag === "Success") {
        expect(actorExit.value._tag).toBe("Defect");
      }
      yield* actor.stop;
    }),
  );

  it.scopedLive("deferred reply schema mismatch is a defect and settles the ask", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.Finite) });
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, ({ self }) => self.reply("not-a-number"));
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const exit = yield* actor.ask(ReplyEvent.Request).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasDies(exit.cause)).toBe(true);
      }
      const actorExit = yield* actor.awaitExit.pipe(Effect.timeout("1 second"), Effect.exit);
      expect(actorExit._tag).toBe("Success");
      if (actorExit._tag === "Success") {
        expect(actorExit.value._tag).toBe("Defect");
      }
      yield* actor.stop;
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("deferred replies return the decoded schema value", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.FiniteFromString) });
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, ({ self }) => self.reply("42"));
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const result = yield* actor.ask(ReplyEvent.Request);

      expect(result).toBe(42);
      yield* actor.stop;
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("deferred replies accept an explicit undefined value", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.Undefined) });
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, ({ self }) => self.reply(undefined));
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const result = yield* actor.ask(ReplyEvent.Request);

      expect(result).toBeUndefined();
      yield* actor.stop;
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("only the first deferred reply settles the pending ask", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.String) });
      const replyResults: Array<boolean> = [];
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, ({ self }) =>
          self.reply("ready").pipe(
            Effect.tap((settled) => Effect.sync(() => replyResults.push(settled))),
            Effect.andThen(self.reply("late")),
            Effect.tap((settled) => Effect.sync(() => replyResults.push(settled))),
          ),
        );
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const result = yield* actor.ask(ReplyEvent.Request);
      yield* yieldFibers;

      expect(result).toBe("ready");
      expect(replyResults).toEqual([true, false]);
      yield* actor.stop;
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("settles an ask when state exit interrupts deferred reply decoding", () =>
    Effect.scoped(
      Machine.scoped(
        Effect.gen(function* () {
          const ReplyState = State({ Idle: {}, Replying: {}, Other: {} });
          const decodeStarted = yield* Deferred.make<void>();
          const decodeGate = yield* Deferred.make<void>();
          const decodeInterrupted = yield* Deferred.make<void>();
          const AsyncReply = Schema.declareConstructor<string>()(
            [],
            () => () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(decodeStarted, void 0);
                yield* Deferred.await(decodeGate);
                return "ready";
              }).pipe(Effect.onInterrupt(() => Deferred.succeed(decodeInterrupted, void 0))),
          );
          const ReplyEvent = Event({
            Request: Event.reply({}, AsyncReply),
            Cancel: {},
            Ping: {},
          });
          const machine = Machine.make({
            state: ReplyState,
            event: ReplyEvent,
            initial: ReplyState.Idle,
          })
            .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
            .on(ReplyState.Replying, ReplyEvent.Cancel, () => ReplyState.Other)
            .on(ReplyState.Other, ReplyEvent.Ping, () => ReplyState.Other)
            .spawn(ReplyState.Replying, ({ self }) => self.reply("raw"));
          const actor = yield* Machine.spawn(machine);
          yield* actor.start;

          const pending = yield* actor.ask(ReplyEvent.Request).pipe(Effect.forkChild);
          yield* Deferred.await(decodeStarted);

          const transition = yield* actor
            .call(ReplyEvent.Cancel)
            .pipe(Effect.timeout("1 second"), Effect.exit);
          expect(transition._tag).toBe("Success");
          if (transition._tag === "Success") {
            expect(transition.value.newState).toEqual(ReplyState.Other);
          }

          const interrupted = yield* Deferred.await(decodeInterrupted).pipe(
            Effect.timeout("1 second"),
            Effect.exit,
          );
          expect(interrupted._tag).toBe("Success");

          const alive = yield* actor
            .call(ReplyEvent.Ping)
            .pipe(Effect.timeout("1 second"), Effect.exit);
          expect(alive._tag).toBe("Success");

          const replyExit = yield* Fiber.await(pending).pipe(
            Effect.timeout("1 second"),
            Effect.exit,
          );
          expect(replyExit._tag).toBe("Success");
          if (replyExit._tag === "Success") {
            expect(replyExit.value._tag).toBe("Failure");
            if (replyExit.value._tag === "Failure") {
              expect(Cause.hasInterruptsOnly(replyExit.value.cause)).toBe(true);
            }
          }
          yield* actor.stop;
        }),
      ),
    ).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("keeps deferred replies matched across postponed asks", () =>
    Effect.gen(function* () {
      const AskState = State({
        Waiting: {},
        Loading: { id: Schema.String },
        Ready: {},
        Replying: { id: Schema.String },
      });
      const AskEvent = Event({
        Request: Event.reply({ id: Schema.String }, Schema.String),
        Loaded: {},
      });
      const loadingStarted = yield* Deferred.make<void>();
      const releaseLoading = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: AskState,
        event: AskEvent,
        initial: AskState.Waiting,
      })
        .on(AskState.Waiting, AskEvent.Request, ({ event }) =>
          Machine.deferReply(AskState.Loading({ id: event.id })),
        )
        .on(AskState.Loading, AskEvent.Loaded, () => AskState.Ready)
        .on(AskState.Ready, AskEvent.Request, ({ event }) =>
          Machine.deferReply(AskState.Replying({ id: event.id })),
        )
        .spawn(AskState.Loading, ({ self, state }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(loadingStarted, void 0);
            yield* Deferred.await(releaseLoading);
            yield* self.reply(state.id);
            yield* self.send(AskEvent.Loaded);
          }),
        )
        .spawn(AskState.Replying, ({ self, state }) => self.reply(state.id))
        .postpone(AskState.Loading, AskEvent.Request);
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const first = yield* actor.ask(AskEvent.Request({ id: "first" })).pipe(Effect.forkChild);
      yield* Deferred.await(loadingStarted);
      const second = yield* actor.ask(AskEvent.Request({ id: "second" })).pipe(Effect.forkChild);
      yield* yieldFibers;

      expect((yield* actor.snapshot)._tag).toBe("Loading");
      yield* Deferred.succeed(releaseLoading, void 0);

      const firstResult = yield* Fiber.join(first).pipe(Effect.timeout("1 second"), Effect.exit);
      expect(firstResult._tag).toBe("Success");
      if (firstResult._tag === "Success") {
        expect(firstResult.value).toBe("first");
      }
      const secondResult = yield* Fiber.join(second).pipe(Effect.timeout("1 second"), Effect.exit);
      expect(secondResult._tag).toBe("Success");
      if (secondResult._tag === "Success") {
        expect(secondResult.value).toBe("second");
      }
      yield* actor.stop;
    }).pipe(Effect.timeout("2 seconds")),
  );

  it.scopedLive("stops a pending deferred ask with ActorStoppedError", () =>
    Effect.gen(function* () {
      const ReplyState = State({ Idle: {}, Replying: {} });
      const ReplyEvent = Event({ Request: Event.reply({}, Schema.String) });
      const replyStarted = yield* Deferred.make<void>();
      const releaseReply = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: ReplyState,
        event: ReplyEvent,
        initial: ReplyState.Idle,
      })
        .on(ReplyState.Idle, ReplyEvent.Request, () => Machine.deferReply(ReplyState.Replying))
        .spawn(ReplyState.Replying, ({ self }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(replyStarted, void 0);
            yield* Deferred.await(releaseReply);
            yield* self.reply("late");
          }),
        );
      const actor = yield* Machine.spawn(machine);
      yield* Effect.addFinalizer(() => actor.stop);
      yield* actor.start;

      const pending = yield* actor.ask(ReplyEvent.Request).pipe(Effect.forkChild);
      yield* Deferred.await(replyStarted);
      yield* actor.stop;

      const pendingExit = yield* Fiber.await(pending).pipe(Effect.timeout("1 second"), Effect.exit);
      expect(pendingExit._tag).toBe("Success");
      if (pendingExit._tag === "Success") {
        expect(pendingExit.value._tag).toBe("Failure");
        if (pendingExit.value._tag === "Failure") {
          const failure = Cause.findErrorOption(pendingExit.value.cause);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value._tag).toBe("ActorStoppedError");
          }
        }
      }
    }).pipe(Effect.timeout("2 seconds")),
  );
});
