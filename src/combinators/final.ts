import type { Machine } from "../machine.js";
import { addFinal } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Mark a state as final (stops the actor when entered).
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FetcherState, FetcherEvent>(State.Idle({})),
 *   final(State.Success),
 *   final(State.Failure)
 * )
 * ```
 */
export function final<NarrowedState extends BrandedState>(stateConstructor: {
  (...args: never[]): NarrowedState;
}) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: Machine<State, Event, R, Effects>,
  ): Machine<State, Event, R, Effects> => addFinal<State, Event, R, Effects>(stateTag)(builder);
}
