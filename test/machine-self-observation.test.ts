// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Deferred, Effect, Queue, Schema, SubscriptionRef } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  ActorSystemDefault,
  Event,
  Machine,
  State,
  Supervision,
  type MachineRef,
} from "../src/index.js";

const TestState = State({
  Idle: {},
  Active: { count: Schema.Finite },
});
type TestState = typeof TestState.Type;

const TestEvent = Event({
  Start: { count: Schema.Finite },
  Increment: {},
  Reject: {},
  Crash: {},
});
type TestEvent = typeof TestEvent.Type;

interface SelfSource {
  readonly state: MachineRef<TestEvent, TestState>["state"];
  readonly latestTransition: MachineRef<TestEvent, TestState>["latestTransition"];
}

describe("machine self observation", () => {
  it.scopedLive("shares typed actor refs for accepted transitions and stop cleanup", () =>
    Effect.gen(function* () {
      const sourceReady = yield* Deferred.make<SelfSource>();
      const cleaned = yield* Deferred.make<void>();
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ count: event.count }),
        )
        .on(TestState.Active, TestEvent.Increment, ({ state }) =>
          TestState.Active({ count: state.count + 1 }),
        )
        .when(
          TestState.Active,
          TestEvent.Reject,
          () => false,
          ({ state }) => TestState.Active.with(state),
        )
        .on(TestState.Active, TestEvent.Crash, () => Effect.die("boom"))
        .background(({ self }) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(sourceReady, {
              state: self.state,
              latestTransition: self.latestTransition,
            });
            return yield* Effect.never.pipe(
              Effect.onInterrupt(() => Deferred.succeed(cleaned, undefined)),
            );
          }),
        );

      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      const source = yield* Deferred.await(sourceReady);

      expect(source.state).toBe(actor.state);
      expect(source.latestTransition).toBe(actor.latestTransition);
      expect((yield* SubscriptionRef.get(source.state))._tag).toBe("Idle");
      expect(yield* SubscriptionRef.get(source.latestTransition)).toBeUndefined();

      yield* actor.call(TestEvent.Start({ count: 3 }));
      const accepted = yield* SubscriptionRef.get(source.latestTransition);
      expect(accepted?.fromState._tag).toBe("Idle");
      expect(accepted?.toState._tag).toBe("Active");
      const exactEvent: TestEvent | undefined = accepted?.event;
      expect(exactEvent?._tag).toBe("Start");
      if (exactEvent?._tag === "Start") {
        expect(exactEvent.count).toBe(3);
      }

      const rejected = yield* actor.call(TestEvent.Reject);
      expect(rejected.transitioned).toBe(false);
      expect(yield* SubscriptionRef.get(source.latestTransition)).toBe(accepted);

      yield* actor.call(TestEvent.Increment);
      const incremented = yield* SubscriptionRef.get(source.latestTransition);
      expect(incremented?.event._tag).toBe("Increment");
      const current = yield* SubscriptionRef.get(source.state);
      expect(current._tag).toBe("Active");
      if (current._tag === "Active") {
        expect(current.count).toBe(4);
      }

      yield* actor.stop;
      yield* Deferred.await(cleaned);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("reuses refs and clears the prior transition for a new generation", () =>
    Effect.gen(function* () {
      const started = yield* Queue.unbounded<{
        readonly generation: number;
        readonly source: SelfSource;
        readonly latestAtStart: TestEvent["_tag"] | undefined;
      }>();
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      })
        .on(TestState.Idle, TestEvent.Start, ({ event }) =>
          TestState.Active({ count: event.count }),
        )
        .on(TestState.Active, TestEvent.Crash, () => Effect.die("boom"))
        .background(({ generation, self }) =>
          SubscriptionRef.get(self.latestTransition).pipe(
            Effect.flatMap((latest) =>
              Queue.offer(started, {
                generation,
                source: {
                  state: self.state,
                  latestTransition: self.latestTransition,
                },
                latestAtStart: latest?.event._tag,
              }),
            ),
            Effect.andThen(Effect.never),
          ),
        );

      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 1 }),
      });
      yield* actor.start;
      const firstGeneration = yield* Queue.take(started);
      expect(firstGeneration.generation).toBe(0);
      expect(firstGeneration.latestAtStart).toBeUndefined();

      yield* actor.call(TestEvent.Start({ count: 1 }));
      yield* actor.send(TestEvent.Crash);

      const secondGeneration = yield* Queue.take(started);
      expect(secondGeneration.generation).toBe(1);
      expect(secondGeneration.source.state).toBe(firstGeneration.source.state);
      expect(secondGeneration.source.latestTransition).toBe(
        firstGeneration.source.latestTransition,
      );
      expect(secondGeneration.latestAtStart).toBeUndefined();
      expect((yield* SubscriptionRef.get(secondGeneration.source.state))._tag).toBe("Idle");

      yield* actor.call(TestEvent.Start({ count: 2 }));
      const latest = yield* SubscriptionRef.get(secondGeneration.source.latestTransition);
      expect(latest?.event._tag).toBe("Start");
      if (latest?.event._tag === "Start") {
        expect(latest.event.count).toBe(2);
      }
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
