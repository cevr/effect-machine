import type { MachineBuilder } from "../machine.js";
import { addEffectSlot } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Register a named onEnter slot for a state.
 * The actual effect handler is provided via `Machine.provide`.
 *
 * @example
 * ```ts
 * const machine = Machine.make<FetcherState, FetcherEvent>(State.Idle({})).pipe(
 *   Machine.on(State.Idle, Event.Fetch, () => State.Success({ data: "ok" })),
 *   Machine.onEnter(State.Success, "notifyUser"),
 * )
 *
 * // Then provide the implementation:
 * const machineLive = Machine.provide(machine, {
 *   notifyUser: ({ state }) => Effect.log(`Success: ${state.data}`),
 * })
 * ```
 */
export function onEnter<NarrowedState extends BrandedState, Name extends string>(
  stateConstructor: { (...args: never[]): NarrowedState },
  name: Name,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: MachineBuilder<State, Event, R, Effects>,
  ): MachineBuilder<State, Event, R, Effects | Name> => {
    return addEffectSlot<State, Event, R, Effects, Name>({
      type: "onEnter",
      stateTag,
      name,
    })(builder);
  };
}
