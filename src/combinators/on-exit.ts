import type { AnySlot, EffectSlotType, Machine } from "../machine.js";
import { addEffectSlot } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

/** Type-level onExit slot */
type OnExitSlot<Name extends string> = EffectSlotType<"onExit", Name>;

/**
 * Register a named onExit slot for a state.
 * The actual effect handler is provided via `Machine.provide`.
 *
 * @example
 * ```ts
 * const machine = Machine.make<FetcherState, FetcherEvent>(State.Idle()).pipe(
 *   Machine.on(State.Idle, Event.Fetch, () => State.Loading({ url: "/api" })),
 *   Machine.on(State.Loading, Event.Resolve, () => State.Success({ data: "ok" })),
 *   Machine.onExit(State.Loading, "cleanup"),
 * )
 *
 * // Then provide the implementation:
 * const machineLive = Machine.provide(machine, {
 *   cleanup: () => Effect.log("Cleaning up loading state"),
 * })
 * ```
 */
export function onExit<NarrowedState extends BrandedState, Name extends string>(
  stateConstructor: { (...args: never[]): NarrowedState },
  name: Name,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R, Slots | OnExitSlot<Name>> => {
    return addEffectSlot<State, Event, R, OnExitSlot<Name>>({
      type: "onExit",
      stateTag,
      name,
    })(builder);
  };
}
