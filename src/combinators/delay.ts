import { Duration, Effect, Fiber } from "effect";
import type { DurationInput } from "effect/Duration";

import type { MachineBuilder, StateEffect } from "../Machine.js";
import { addOnEnter, addOnExit } from "../Machine.js";
import { getTag } from "../internal/getTag.js";

/**
 * Options for delayed event scheduling
 */
export interface DelayOptions<S> {
  readonly guard?: (state: S) => boolean;
}

/**
 * Schedule an event to be sent after a delay when entering a state.
 * The delay timer starts when entering the state and is cancelled on exit.
 * Works with TestClock for deterministic testing.
 *
 * @example
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
 * @example With guard
 * ```ts
 * // Only auto-dismiss non-retryable errors
 * delay(State.Error, "3 seconds", Event.Dismiss(), {
 *   guard: (state) => !state.canRetry,
 * })
 * ```
 */
export function delay<
  NarrowedState extends { readonly _tag: string },
  EventType extends { readonly _tag: string },
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  duration: DurationInput,
  event: EventType,
  options?: DelayOptions<NarrowedState>,
) {
  const stateTag = getTag(stateConstructor);
  const decodedDuration = Duration.decode(duration);

  // Store the fiber ref for cleanup
  let timerFiber: Fiber.RuntimeFiber<void, never> | null = null;

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R> => {
    const enterEffect: StateEffect<State, Event, never> = {
      stateTag,
      handler: ({ state, self }) => {
        const typedState = state as unknown as NarrowedState;

        // Check guard
        if (options?.guard && !options.guard(typedState)) {
          return Effect.void;
        }

        return Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            Effect.gen(function* () {
              yield* Effect.sleep(decodedDuration);
              yield* self.send(event as unknown as Event);
            }),
          );
          timerFiber = fiber;
        });
      },
    };

    const exitEffect: StateEffect<State, Event, never> = {
      stateTag,
      handler: () =>
        Effect.suspend(() => {
          if (timerFiber) {
            const fiber = timerFiber;
            timerFiber = null;
            return Fiber.interrupt(fiber).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b1 = addOnEnter(enterEffect)(builder) as MachineBuilder<State, Event, any>;
    return addOnExit(exitEffect)(b1) as MachineBuilder<State, Event, R>;
  };
}
