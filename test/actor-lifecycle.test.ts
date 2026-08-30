// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Effect, Option } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "../src/index.js";

const TestState = State({ Idle: {}, Done: {} });
const TestEvent = Event({ Finish: {} });

const machine = Machine.make({
  state: TestState,
  event: TestEvent,
  initial: TestState.Idle,
})
  .on(TestState.Idle, TestEvent.Finish, () => TestState.Done)
  .final(TestState.Done);

describe("actor lifecycle observation", () => {
  it.scopedLive("keeps lifecycle and latest transition after final exit", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      expect(actor.client.getLifecycle()._tag).toBe("Created");
      yield* actor.start;
      expect(actor.client.getLifecycle()._tag).toBe("Active");

      yield* actor.send(TestEvent.Finish);
      yield* actor.awaitExit;
      yield* Effect.yieldNow;

      expect(actor.client.getLifecycle()._tag).toBe("Final");
      const latest = actor.client.getLatestTransition();
      expect(latest?.fromState._tag).toBe("Idle");
      expect(latest?.toState._tag).toBe("Done");
      expect(latest?.event._tag).toBe("Finish");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("updates latest transition before synchronous state listeners", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const observed = yield* Deferred.make<string>();
      // @effect-diagnostics runEffectInsideEffect:off -- synchronous actor callback
      actor.subscribe(() => {
        const latest = actor.client.getLatestTransition();
        Effect.runFork(Deferred.succeed(observed, latest?.event._tag ?? "missing"));
      });
      // @effect-diagnostics runEffectInsideEffect:on

      yield* actor.send(TestEvent.Finish);
      expect(yield* Deferred.await(observed)).toBe("Finish");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("removes terminal actors from the actor system", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const stopped = yield* Deferred.make<void>();
      // @effect-diagnostics runEffectInsideEffect:off -- synchronous system callback
      system.subscribe((event) => {
        if (event._tag === "ActorStopped" && event.id === "terminal") {
          Effect.runFork(Deferred.succeed(stopped, undefined));
        }
      });
      // @effect-diagnostics runEffectInsideEffect:on
      const actor = yield* system.spawn("terminal", machine);
      yield* actor.send(TestEvent.Finish);
      yield* Deferred.await(stopped);

      expect(Option.isNone(yield* system.get("terminal"))).toBe(true);
      expect(system.actors.has("terminal")).toBe(false);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
