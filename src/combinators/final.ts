import type { MachineBuilder } from "../machine.js";
import { addFinal } from "../machine.js";
import { getTag } from "../internal/get-tag.js";

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
export function final<NarrowedState extends { readonly _tag: string }>(stateConstructor: {
  (...args: never[]): NarrowedState;
}) {
  const stateTag = getTag(stateConstructor);

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R> => addFinal<State, Event, R>(stateTag)(builder);
}
