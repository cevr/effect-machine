import { Duration, Effect, Fiber } from "effect";
import type { DurationInput } from "effect/Duration";

import type { Machine, StateEffect } from "../machine.js";
import { addOnEnter, addOnExit } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";
import { createFiberStorage } from "../internal/fiber-storage.js";

/**
 * Options for delayed event scheduling
 */
export interface DelayOptions<S> {
  readonly guard?: (state: S) => boolean;
}

/**
 * Duration that can be static or computed from state at entry time
 */
export type DurationOrFn<S> = DurationInput | ((state: S) => DurationInput);

/**
 * Schedule an event to be sent after a delay when entering a state.
 * The delay timer starts when entering the state and is cancelled on exit.
 * Works with TestClock for deterministic testing.
 *
 * @example Static duration
 * ```ts
 * pipe(
 *   Machine.make<NotificationState, NotificationEvent>(State.Idle()),
 *   on(State.Idle, Event.Show, ({ event }) => State.Success({ message: event.message })),
 *   on(State.Success, Event.Dismiss, () => State.Dismissed()),
 *   // Auto-dismiss after 3 seconds
 *   delay(State.Success, "3 seconds", Event.Dismiss()),
 *   final(State.Dismissed),
 * )
 * ```
 *
 * @example Dynamic duration from state
 * ```ts
 * // Timeout duration from state
 * delay(State.Polling, (state) => Duration.seconds(state.timeout), Event.Timeout())
 *
 * // Duration from settings
 * delay(State.Success, () => Duration.seconds(getSettings().autoDismiss), Event.Dismiss())
 * ```
 *
 * @example With guard
 * ```ts
 * // Only auto-dismiss non-retryable errors
 * delay(State.Error, "3 seconds", Event.Dismiss(), {
 *   guard: (state) => !state.canRetry,
 * })
 * ```
 */
export function delay<NarrowedState extends BrandedState, EventType extends BrandedEvent>(
  stateConstructor: { (...args: never[]): NarrowedState },
  duration: DurationOrFn<NarrowedState>,
  event: EventType,
  options?: DelayOptions<NarrowedState>,
) {
  const stateTag = getTag(stateConstructor);

  // Pre-decode if static duration
  const staticDuration = typeof duration !== "function" ? Duration.decode(duration) : null;

  // Unique key for this delay instance within the state
  // Multiple delays on same state need separate storage
  const delayKey = Symbol("delay");

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: Machine<State, Event, R, Effects>,
  ): Machine<State, Event, R, Effects> => {
    const getFiberMap = createFiberStorage();

    const enterEffect: StateEffect<State, Event, never> = {
      stateTag,
      handler: ({ state, self }) => {
        const typedState = state as unknown as NarrowedState;

        // Check guard
        if (options?.guard !== undefined && !options.guard(typedState)) {
          return Effect.void;
        }

        // Compute duration at entry time
        const resolvedDuration =
          staticDuration ??
          Duration.decode((duration as (state: NarrowedState) => DurationInput)(typedState));

        return Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.gen(function* () {
              yield* Effect.sleep(resolvedDuration);
              yield* self.send(event as unknown as Event);
            }),
          );
          getFiberMap(self).set(delayKey, fiber);
        });
      },
    };

    const exitEffect: StateEffect<State, Event, never> = {
      stateTag,
      handler: ({ self }) =>
        Effect.suspend(() => {
          const fiberMap = getFiberMap(self);
          const fiber = fiberMap.get(delayKey);
          if (fiber !== undefined) {
            fiberMap.delete(delayKey);
            return Fiber.interrupt(fiber).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b1 = addOnEnter(enterEffect)(builder) as Machine<State, Event, any, Effects>;
    return addOnExit(exitEffect)(b1) as Machine<State, Event, R, Effects>;
  };
}
