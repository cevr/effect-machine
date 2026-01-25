import type { Effect } from "effect";

import type { MachineBuilder, StateEffect } from "../Machine.js";
import { addOnEnter } from "../Machine.js";
import { getTag } from "../internal/getTag.js";
import type { StateEffectContext } from "../internal/types.js";

/**
 * Define an effect to run when entering a state.
 * Handler receives a context object with { state, self }.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FetcherState, FetcherEvent>(State.Idle({})),
 *   onEnter(State.Loading, ({ state, self }) =>
 *     pipe(
 *       fetch(state.url),
 *       Effect.map((data) => Event._Done({ data })),
 *       Effect.flatMap(self.send),
 *       Effect.fork,
 *       Effect.asVoid
 *     )
 *   )
 * )
 * ```
 */
export function onEnter<
  NarrowedState extends { readonly _tag: string },
  EventType extends { readonly _tag: string },
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  handler: (ctx: StateEffectContext<NarrowedState, EventType>) => Effect.Effect<void, never, R2>,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    const effect: StateEffect<State, Event, R2> = {
      stateTag,
      handler: handler as unknown as (
        ctx: StateEffectContext<State, Event>,
      ) => Effect.Effect<void, never, R2>,
    };

    return addOnEnter(effect)(builder) as MachineBuilder<State, Event, R | R2>;
  };
}
