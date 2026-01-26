import type { Effect } from "effect";

import type { MachineBuilder, OnOptions, Transition } from "../machine.js";
import { addTransition, normalizeOnOptions } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";

/**
 * Define a transition from one state to another on an event.
 * Handler receives a context object with { state, event }.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FetcherState, FetcherEvent>(State.Idle({})),
 *   on(State.Idle, Event.Fetch, ({ state, event }) =>
 *     State.Loading({ url: event.url })
 *   )
 * )
 * ```
 *
 * @example With guard and effect
 * ```ts
 * on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url }), {
 *   guard: ({ state }) => state.canFetch,
 *   effect: ({ state, event }) => Effect.log(`Fetching ${event.url}`),
 * })
 * ```
 */
function onImpl<
  NarrowedState extends { readonly _tag: string },
  NarrowedEvent extends { readonly _tag: string },
  ResultState extends { readonly _tag: string },
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  eventConstructor: { (...args: never[]): NarrowedEvent },
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const stateTag = getTag(stateConstructor);
  const eventTag = getTag(eventConstructor);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    const transition: Transition<State, Event, R2> = {
      stateTag,
      eventTag,
      handler: handler as unknown as (
        ctx: TransitionContext<State, Event>,
      ) => TransitionResult<State, R2>,
      guard: normalizedOptions?.guard as unknown as
        | ((ctx: TransitionContext<State, Event>) => boolean)
        | undefined,
      guardName: normalizedOptions?.guardName,
      effect: normalizedOptions?.effect as unknown as
        | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
        | undefined,
      reenter: normalizedOptions?.reenter,
    };

    return addTransition(transition)(builder) as MachineBuilder<State, Event, R | R2>;
  };
}

/**
 * Options for on.force (no reenter option since it's always true)
 */
export interface OnForceOptions<S, E, R> {
  readonly guard?: OnOptions<S, E, R>["guard"];
  readonly effect?: OnOptions<S, E, R>["effect"];
}

/**
 * Force a transition to run exit/enter effects even when staying in the same state.
 * Use for restarting timers, re-running invoke effects, or resetting state lifecycle.
 *
 * @example Restart a polling timer on reset
 * ```ts
 * pipe(
 *   make<State, Event>(State.Polling({ attempts: 0 })),
 *   on.force(State.Polling, Event.Reset, ({ state }) =>
 *     State.Polling({ attempts: state.attempts + 1 })
 *   ),
 *   delay(State.Polling, "5 seconds", Event.Poll()),
 * )
 * ```
 */
function force<
  NarrowedState extends { readonly _tag: string },
  NarrowedEvent extends { readonly _tag: string },
  ResultState extends { readonly _tag: string },
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  eventConstructor: { (...args: never[]): NarrowedEvent },
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
) {
  return onImpl(stateConstructor, eventConstructor, handler, {
    ...options,
    reenter: true,
  });
}

/**
 * Define a transition from one state to another on an event.
 *
 * - `on(State, Event, handler)` - normal transition (skips exit/enter for same state tag)
 * - `on.force(State, Event, handler)` - forces exit/enter even for same state tag
 */
export const on = Object.assign(onImpl, { force });
