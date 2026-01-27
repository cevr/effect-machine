import type { Machine } from "../machine.js";
import { addEffectSlot } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

/**
 * Register a named invoke slot for a state.
 * The actual effect handler is provided via `Machine.provide`.
 *
 * @example
 * ```ts
 * const machine = Machine.make<FetcherState, FetcherEvent>(State.Idle({})).pipe(
 *   Machine.on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
 *   Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
 *   Machine.invoke(State.Loading, "fetchData"),
 * )
 *
 * // Then provide the implementation:
 * const machineLive = Machine.provide(machine, {
 *   fetchData: ({ state, self }) =>
 *     Effect.gen(function* () {
 *       const http = yield* HttpClient
 *       const data = yield* http.get(state.url)
 *       yield* self.send(Event.Resolve({ data }))
 *     }),
 * })
 * ```
 */
export function invoke<NarrowedState extends BrandedState, Name extends string>(
  stateConstructor: { (...args: never[]): NarrowedState },
  name: Name,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: Machine<State, Event, R, Effects>,
  ): Machine<State, Event, R, Effects | Name> => {
    return addEffectSlot<State, Event, R, Effects, Name>({
      type: "invoke",
      stateTag,
      name,
    })(builder);
  };
}
