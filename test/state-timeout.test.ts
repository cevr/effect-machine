// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Duration, Effect, Schema, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import {
  ActorSystemDefault,
  ActorSystemService,
  InspectorService,
  collectingInspector,
  Machine,
  State,
  Event,
} from "../src/index.js";
import type { InspectionEvent } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const TimeoutState = State({
  Loading: {},
  TimedOut: {},
  Done: {},
});

const TimeoutEvent = Event({
  Timeout: {},
  Complete: {},
});

describe(".timeout()", () => {
  it.scoped("fires event after static duration", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TimeoutState,
        event: TimeoutEvent,
        initial: TimeoutState.Loading,
      })
        .on(TimeoutState.Loading, TimeoutEvent.Timeout, () => TimeoutState.TimedOut)
        .on(TimeoutState.Loading, TimeoutEvent.Complete, () => TimeoutState.Done)
        .timeout(TimeoutState.Loading, {
          duration: Duration.seconds(5),
          event: TimeoutEvent.Timeout,
        })
        .final(TimeoutState.TimedOut)
        .final(TimeoutState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Loading");

      yield* TestClock.adjust("5 seconds");
      yield* yieldFibers;

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("cancelled on state exit before timeout fires", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TimeoutState,
        event: TimeoutEvent,
        initial: TimeoutState.Loading,
      })
        .on(TimeoutState.Loading, TimeoutEvent.Timeout, () => TimeoutState.TimedOut)
        .on(TimeoutState.Loading, TimeoutEvent.Complete, () => TimeoutState.Done)
        .timeout(TimeoutState.Loading, {
          duration: Duration.seconds(5),
          event: TimeoutEvent.Timeout,
        })
        .final(TimeoutState.TimedOut)
        .final(TimeoutState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Leave state before timeout
      yield* actor.call(TimeoutEvent.Complete);

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Done");

      // Advance past timeout — should not cause issues
      yield* TestClock.adjust("10 seconds");
      yield* yieldFibers;

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Done");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("same-tag .on() transition does not restart the timer", () =>
    Effect.gen(function* () {
      const CountState = State({
        Active: { count: Schema.Number },
        TimedOut: {},
      });

      const CountEvent = Event({
        Increment: {},
        Timeout: {},
      });

      const machine = Machine.make({
        state: CountState,
        event: CountEvent,
        initial: CountState.Active({ count: 0 }),
      })
        // Normal same-tag transition (not .reenter) — should NOT restart timer
        .on(CountState.Active, CountEvent.Increment, ({ state }) =>
          CountState.Active({ count: state.count + 1 }),
        )
        .on(CountState.Active, CountEvent.Timeout, () => CountState.TimedOut)
        .timeout(CountState.Active, {
          duration: Duration.seconds(3),
          event: CountEvent.Timeout,
        })
        .final(CountState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Advance 2 seconds
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;

      // Same-tag transition — should NOT restart the timer
      yield* actor.send(CountEvent.Increment);
      yield* yieldFibers;

      // Advance 1 more second (3 total from start) → timeout should fire
      yield* TestClock.adjust("1 second");
      yield* yieldFibers;

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("reenter restarts the timer", () =>
    Effect.gen(function* () {
      const RetryState = State({
        Waiting: { attempt: Schema.Number },
        TimedOut: {},
      });

      const RetryEvent = Event({
        Retry: {},
        Timeout: {},
      });

      const machine = Machine.make({
        state: RetryState,
        event: RetryEvent,
        initial: RetryState.Waiting({ attempt: 1 }),
      })
        .reenter(RetryState.Waiting, RetryEvent.Retry, ({ state }) =>
          RetryState.Waiting({ attempt: state.attempt + 1 }),
        )
        .on(RetryState.Waiting, RetryEvent.Timeout, () => RetryState.TimedOut)
        .timeout(RetryState.Waiting, {
          duration: Duration.seconds(3),
          event: RetryEvent.Timeout,
        })
        .final(RetryState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Advance 2 seconds (not enough)
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Waiting");

      // Retry → reenter restarts the 3s timer
      yield* actor.send(RetryEvent.Retry);
      yield* yieldFibers;

      // Advance 2 more seconds (4 total from start, but only 2 from retry)
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Waiting");

      // Advance 1 more second (3 from retry) → timeout fires
      yield* TestClock.adjust("1 second");
      yield* yieldFibers;
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("dynamic duration computed from state", () =>
    Effect.gen(function* () {
      const DynState = State({
        Waiting: { timeoutMs: Schema.Number },
        TimedOut: {},
      });

      const DynEvent = Event({
        Timeout: {},
      });

      const machine = Machine.make({
        state: DynState,
        event: DynEvent,
        initial: DynState.Waiting({ timeoutMs: 2000 }),
      })
        .on(DynState.Waiting, DynEvent.Timeout, () => DynState.TimedOut)
        .timeout(DynState.Waiting, {
          duration: (state: typeof DynState.Type & { _tag: "Waiting" }) =>
            Duration.millis(state.timeoutMs),
          event: DynEvent.Timeout,
        })
        .final(DynState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* TestClock.adjust("1 second");
      yield* yieldFibers;
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Waiting");

      yield* TestClock.adjust("1 second");
      yield* yieldFibers;
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("dynamic event computed from state", () =>
    Effect.gen(function* () {
      const EvState = State({
        Active: { shouldTimeout: Schema.Boolean },
        TimedOut: {},
        Done: {},
      });

      const EvEvent = Event({
        Timeout: {},
        Complete: {},
      });

      const machine = Machine.make({
        state: EvState,
        event: EvEvent,
        initial: EvState.Active({ shouldTimeout: true }),
      })
        .on(EvState.Active, EvEvent.Timeout, () => EvState.TimedOut)
        .on(EvState.Active, EvEvent.Complete, () => EvState.Done)
        .timeout(EvState.Active, {
          duration: Duration.seconds(1),
          event: (state) => (state.shouldTimeout ? EvEvent.Timeout : EvEvent.Complete),
        })
        .final(EvState.TimedOut)
        .final(EvState.Done);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* TestClock.adjust("1 second");
      yield* yieldFibers;

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("inspection events emitted with $timeout: name", () => {
    const events: InspectionEvent<typeof TimeoutState.Type, typeof TimeoutEvent.Type>[] = [];
    return Effect.gen(function* () {
      const machine = Machine.make({
        state: TimeoutState,
        event: TimeoutEvent,
        initial: TimeoutState.Loading,
      })
        .on(TimeoutState.Loading, TimeoutEvent.Timeout, () => TimeoutState.TimedOut)
        .timeout(TimeoutState.Loading, {
          duration: Duration.seconds(1),
          event: TimeoutEvent.Timeout,
        })
        .final(TimeoutState.TimedOut);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* TestClock.adjust("1 second");
      yield* yieldFibers;

      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("TimedOut");

      // Should have start + success inspection events with $timeout:Loading name
      const taskEvents = events.filter(
        (e) => e.type === "@machine.task" && e.taskName === "$timeout:Loading",
      );
      expect(taskEvents.length).toBeGreaterThanOrEqual(2);
      expect(taskEvents.some((e) => e.type === "@machine.task" && e.phase === "start")).toBe(true);
      expect(taskEvents.some((e) => e.type === "@machine.task" && e.phase === "success")).toBe(
        true,
      );
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });
});
