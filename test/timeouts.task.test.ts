// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Duration, Effect, Schema, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import { ActorSystemDefault, Event, Machine, Slot, State } from "../src/index.js";
import { MachineContextTag } from "../src/slot.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

describe("Timeout Transitions via Task", () => {
  const NotifState = State({
    Showing: { message: Schema.String },
    Dismissed: {},
  });
  type NotifState = typeof NotifState.Type;

  const NotifEvent = Event({
    Dismiss: {},
  });

  const NotifSlots = Slot.define({
    scheduleAutoDismiss: Slot.fn({}),
  });

  it.scoped("schedules event after duration with TestClock", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        slots: NotifSlots,
        initial: NotifState.Showing({ message: "Hello" }),
      })
        .on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed)
        .task(NotifState.Showing, ({ slots }) => slots.scheduleAutoDismiss(), {
          onSuccess: () => NotifEvent.Dismiss,
        })
        .final(NotifState.Dismissed);

      const actor = yield* Machine.spawn(machine, {
        id: "notification",
        slots: {
          scheduleAutoDismiss: () => Effect.sleep("3 seconds"),
        },
      });
      yield* actor.start;

      // Initial state
      let current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Showing");

      // Advance time by 3 seconds
      yield* TestClock.adjust("3 seconds");

      // Allow fibers to run
      yield* yieldFibers;

      // Should have transitioned
      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Dismissed");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("cancels timer on state exit before timeout", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: NotifState,
        event: NotifEvent,
        slots: NotifSlots,
        initial: NotifState.Showing({ message: "Hello" }),
      })
        .on(NotifState.Showing, NotifEvent.Dismiss, () => NotifState.Dismissed)
        .task(NotifState.Showing, ({ slots }) => slots.scheduleAutoDismiss(), {
          onSuccess: () => NotifEvent.Dismiss,
        })
        .final(NotifState.Dismissed);

      const actor = yield* Machine.spawn(machine, {
        id: "notification",
        slots: {
          scheduleAutoDismiss: () => Effect.sleep("3 seconds"),
        },
      });
      yield* actor.start;

      // Manual dismiss before timer
      yield* actor.send(NotifEvent.Dismiss);
      yield* yieldFibers;

      let current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Dismissed");

      // Advance time - should not cause issues since timer was cancelled
      yield* TestClock.adjust("5 seconds");
      yield* yieldFibers;

      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Dismissed");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});

describe("Dynamic Timeout Duration via Task", () => {
  const WaitState = State({
    Waiting: { timeout: Schema.Number },
    TimedOut: {},
  });
  type WaitState = typeof WaitState.Type;

  const WaitEvent = Event({
    Timeout: {},
  });

  const WaitSlots = Slot.define({
    scheduleTimeout: Slot.fn({}),
  });

  it.scoped("dynamic duration computed from state", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: WaitState,
        event: WaitEvent,
        slots: WaitSlots,
        initial: WaitState.Waiting({ timeout: 5 }),
      })
        .on(WaitState.Waiting, WaitEvent.Timeout, () => WaitState.TimedOut)
        .task(WaitState.Waiting, ({ slots }) => slots.scheduleTimeout(), {
          onSuccess: () => WaitEvent.Timeout,
        })
        .final(WaitState.TimedOut);

      const actor = yield* Machine.spawn(machine, {
        id: "waiter",
        slots: {
          scheduleTimeout: () =>
            Effect.gen(function* () {
              const ctx = yield* MachineContextTag;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s = ctx.state as any;
              yield* Effect.sleep(Duration.seconds(s.timeout));
            }),
        },
      });
      yield* actor.start;

      // Initial state
      let current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Waiting");

      // Advance 3 seconds - not enough
      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Waiting");

      // Advance 2 more seconds (5 total) - should timeout
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;

      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("TimedOut");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("dynamic duration with different state values", () =>
    Effect.gen(function* () {
      const RetryState = State({
        Retrying: { attempt: Schema.Number, backoff: Schema.Number },
        Failed: {},
        Success: {},
      });
      type RetryState = typeof RetryState.Type;

      const RetryEvent = Event({
        Retry: {},
        GiveUp: {},
      });

      const RetrySlots = Slot.define({
        scheduleGiveUp: Slot.fn({}),
      });

      const machine = Machine.make({
        state: RetryState,
        event: RetryEvent,
        slots: RetrySlots,
        initial: RetryState.Retrying({ attempt: 1, backoff: 1 }),
      })
        .reenter(RetryState.Retrying, RetryEvent.Retry, ({ state }) =>
          RetryState.Retrying({ attempt: state.attempt + 1, backoff: state.backoff * 2 }),
        )
        .on(RetryState.Retrying, RetryEvent.GiveUp, () => RetryState.Failed)
        // Exponential backoff based on state
        .task(RetryState.Retrying, ({ slots }) => slots.scheduleGiveUp(), {
          onSuccess: () => RetryEvent.GiveUp,
        })
        .final(RetryState.Failed);

      const actor = yield* Machine.spawn(machine, {
        id: "retry",
        slots: {
          scheduleGiveUp: () =>
            Effect.gen(function* () {
              const ctx = yield* MachineContextTag;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const s = ctx.state as any;
              yield* Effect.sleep(Duration.seconds(s.backoff));
            }),
        },
      });
      yield* actor.start;

      // Initial state should be Retrying with attempt=1, backoff=1
      let current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Retrying");

      // First retry - resets backoff timer to 2s
      yield* actor.send(RetryEvent.Retry);
      yield* yieldFibers;

      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Retrying");
      if (current._tag === "Retrying") {
        expect(current.backoff).toBe(2);
      }

      // Advance 2 seconds - should trigger give up
      yield* TestClock.adjust("2 seconds");
      yield* yieldFibers;

      current = yield* SubscriptionRef.get(actor.state);
      expect(current._tag).toBe("Failed");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
