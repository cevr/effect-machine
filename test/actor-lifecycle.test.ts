// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  ActorScope,
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
} from "../src/index.js";

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
  it.scopedLive("retains an interrupted first start until the actor is stopped", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let recoveries = 0;
      const actor = yield* Machine.spawn(machine, {
        lifecycle: {
          recovery: {
            resolve: () =>
              Effect.gen(function* () {
                recoveries++;
                yield* Deferred.succeed(entered, undefined);
                return yield* Effect.never;
              }),
          },
        },
      });
      const first = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      expect(Exit.hasInterrupts(yield* actor.start.pipe(Effect.exit))).toBe(true);
      expect(recoveries).toBe(1);
      yield* actor.stop;
      expect(actor.client.getLifecycle()._tag).toBe("Stopped");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps a replacement registered by a scope cleanup listener", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const owner = yield* Scope.make();
      const original = yield* system
        .spawn("reentrant", machine)
        .pipe(Effect.provideService(ActorScope, owner));
      const replacement = yield* Deferred.make<typeof original>();
      const unsubscribe = system.subscribe((event) => {
        if (event._tag !== "ActorStopped" || event.id !== "reentrant") return;
        unsubscribe();
        // @effect-diagnostics-next-line runEffectInsideEffect:off -- A synchronous system listener can start Effect work inline.
        Effect.runFork(
          system.stop("reentrant").pipe(
            Effect.andThen(system.spawn("reentrant", machine)),
            Effect.flatMap((actor) => Deferred.succeed(replacement, actor)),
            Effect.orDie,
          ),
        );
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* Scope.close(owner, Exit.void);
      const actor = yield* Deferred.await(replacement);
      expect(Object.is(system.actors.get("reentrant"), actor)).toBe(true);
      yield* actor.send(TestEvent.Finish);
      expect((yield* actor.awaitExit)._tag).toBe("Final");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("runs recovery once for concurrent and repeated starts", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let recoveries = 0;
      const actor = yield* Machine.spawn(machine, {
        lifecycle: {
          recovery: {
            resolve: () =>
              Effect.gen(function* () {
                recoveries++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return Option.none();
              }),
          },
        },
      });
      const first = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const second = yield* actor.start.pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      yield* actor.start;
      expect(recoveries).toBe(1);
      expect(actor.client.getLifecycle()._tag).toBe("Active");
      yield* actor.stop;
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps terminal lifecycle when start is called again", () =>
    Effect.gen(function* () {
      const unstarted = yield* Machine.spawn(machine);
      yield* unstarted.stop;
      const unstartedExit = yield* unstarted.awaitExit;
      yield* unstarted.start;
      expect(unstarted.client.getLifecycle()).toBe(unstartedExit);

      const stopped = yield* Machine.spawn(machine);
      yield* stopped.start;
      yield* stopped.stop;
      const stoppedExit = yield* stopped.awaitExit;
      yield* stopped.start;
      expect(stopped.client.getLifecycle()).toBe(stoppedExit);

      const finished = yield* Machine.spawn(machine);
      yield* finished.start;
      yield* finished.send(TestEvent.Finish);
      const finalExit = yield* finished.awaitExit;
      yield* finished.start;
      expect(finished.client.getLifecycle()).toBe(finalExit);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps a replacement actor when the previous owner scope closes", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const owner = yield* Scope.make();
      yield* system.spawn("reused", machine).pipe(Effect.provideService(ActorScope, owner));
      yield* system.stop("reused");
      const replacement = yield* system.spawn("reused", machine);
      const registeredReplacement = system.actors.get("reused");
      expect(Object.is(registeredReplacement, replacement)).toBe(true);
      const stoppedIds: string[] = [];
      const unsubscribe = system.subscribe((event) => {
        if (event._tag === "ActorStopped") stoppedIds.push(event.id);
      });
      yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
      yield* Scope.close(owner, Exit.void);
      expect(system.actors.get("reused")).toBe(registeredReplacement);
      expect(stoppedIds).toEqual([]);
      yield* replacement.send(TestEvent.Finish);
      expect((yield* replacement.awaitExit)._tag).toBe("Final");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("keeps lifecycle and latest transition after final exit", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      expect(actor.client.getLifecycle()._tag).toBe("Created");
      yield* actor.start;
      expect(actor.client.getLifecycle()._tag).toBe("Active");

      yield* actor.send(TestEvent.Finish);
      yield* actor.awaitExit;

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
