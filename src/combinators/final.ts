import type { AnySlot, Machine } from "../machine.js";
import { addFinal } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

/**
 * Mark a state as final (stops the actor when entered).
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FetcherState, FetcherEvent>(State.Idle()),
 *   final(State.Success),
 *   final(State.Failure)
 * )
 * ```
 */
export function final<NarrowedState extends BrandedState>(stateConstructor: {
  (...args: never[]): NarrowedState;
}) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R, Slots> => addFinal<State, Event, R>(stateTag)(builder);
}
