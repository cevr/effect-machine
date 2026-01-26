import type { Effect } from "effect";

import type { MachineBuilder, StateEffect } from "../machine.js";
import { addOnEnter } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { StateEffectContext } from "../internal/types.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

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
  NarrowedState extends BrandedState,
  EventType extends BrandedEvent,
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  handler: (ctx: StateEffectContext<NarrowedState, EventType>) => Effect.Effect<void, never, R2>,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R>(
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
