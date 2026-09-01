// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Cause, Effect, Schema } from "effect";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { describe, expect, it } from "effect-bun-test";

import * as ActorAtom from "../src/atom.js";
import { Event, Machine, State } from "../src/index.js";

const LifecycleState = State({ Idle: {}, Listening: {}, Done: {} });
const LifecycleEvent = Event({ Start: {}, Stop: {} });

describe("actor Effect eager start", () => {
  it.scopedLive("starts state Effect setup before state subscribers run", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .spawn(LifecycleState.Listening, () =>
          Effect.sync(() => records.push("setup")).pipe(Effect.andThen(Effect.never)),
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const unsubscribe = actor.subscribe((state) => {
        if (LifecycleState.$is("Listening")(state)) records.push("visible");
      });

      yield* actor.call(LifecycleEvent.Start);

      expect(records).toEqual(["setup", "visible"]);
      unsubscribe();
      yield* actor.stop;
    }),
  );

  it.scopedLive("starts state Effects in registration order", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .spawn(LifecycleState.Listening, () =>
          Effect.sync(() => records.push("first")).pipe(Effect.andThen(Effect.never)),
        )
        .spawn(LifecycleState.Listening, () =>
          Effect.sync(() => records.push("second")).pipe(Effect.andThen(Effect.never)),
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const unsubscribe = actor.subscribe((state) => {
        if (LifecycleState.$is("Listening")(state)) records.push("visible");
      });

      yield* actor.call(LifecycleEvent.Start);

      expect(records).toEqual(["first", "second", "visible"]);
      unsubscribe();
      yield* actor.stop;
    }),
  );

  it.scopedLive("starts task setup before state subscribers run", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .task(
          LifecycleState.Listening,
          () => Effect.sync(() => records.push("task")).pipe(Effect.andThen(Effect.never)),
          { onSuccess: () => LifecycleEvent.Stop },
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const unsubscribe = actor.subscribe((state) => {
        if (LifecycleState.$is("Listening")(state)) records.push("visible");
      });

      yield* actor.call(LifecycleEvent.Start);

      expect(records).toEqual(["task", "visible"]);
      unsubscribe();
      yield* actor.stop;
    }),
  );

  it.scopedLive("starts background Effect setup before actor start completes", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      }).background(() =>
        Effect.sync(() => records.push("background")).pipe(Effect.andThen(Effect.never)),
      );
      const actor = yield* Machine.spawn(machine);

      yield* actor.start;

      expect(records).toEqual(["background"]);
      yield* actor.stop;
    }),
  );

  it.scopedLive("interrupts an eagerly started state Effect on state exit", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .on(LifecycleState.Listening, LifecycleEvent.Stop, () => LifecycleState.Done)
        .spawn(LifecycleState.Listening, () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() => Effect.sync(() => records.push("cleanup")));
            records.push("setup");
            return yield* Effect.never;
          }),
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.call(LifecycleEvent.Start);
      yield* actor.call(LifecycleEvent.Stop);

      expect(records).toEqual(["setup", "cleanup"]);
      yield* actor.stop;
    }),
  );

  it.scopedLive("reports a synchronous state Effect defect as spawn", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .spawn(LifecycleState.Listening, () => Effect.die("spawn boom"));
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      yield* actor.send(LifecycleEvent.Start);
      const exit = yield* actor.awaitExit;

      expect(exit._tag).toBe("Defect");
      if (exit._tag === "Defect") {
        expect(exit.phase).toBe("spawn");
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(false);
        expect(Cause.pretty(exit.cause)).toContain("spawn boom");
      }
    }),
  );

  it.scopedLive("settles a deferred ask from synchronous state Effect setup", () =>
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
            Effect.tap((didReply) => Effect.sync(() => replyResults.push(didReply))),
            Effect.andThen(Effect.never),
          ),
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;

      const reply = yield* Effect.race(
        actor.ask(ReplyEvent.Request),
        Effect.sleep("100 millis").pipe(Effect.as("timeout")),
      );
      yield* Effect.yieldNow;

      expect(reply).toBe("ready");
      expect(replyResults).toEqual([true]);
      yield* actor.stop;
    }),
  );

  it.scopedLive("starts state Effect setup before Actor Atom subscribers run", () =>
    Effect.gen(function* () {
      const records: Array<string> = [];
      const machine = Machine.make({
        state: LifecycleState,
        event: LifecycleEvent,
        initial: LifecycleState.Idle,
      })
        .on(LifecycleState.Idle, LifecycleEvent.Start, () => LifecycleState.Listening)
        .spawn(LifecycleState.Listening, () =>
          Effect.sync(() => records.push("setup")).pipe(Effect.andThen(Effect.never)),
        );
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const registry = AtomRegistry.make();
      const stateAtom = ActorAtom.make(actor);
      const unsubscribe = registry.subscribe(
        stateAtom,
        (state) => {
          if (LifecycleState.$is("Listening")(state)) records.push("visible");
        },
        { immediate: true },
      );

      yield* actor.call(LifecycleEvent.Start);
      yield* Effect.yieldNow;

      expect(records).toEqual(["setup", "visible"]);
      unsubscribe();
      registry.dispose();
      yield* actor.stop;
    }),
  );
});
