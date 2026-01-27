import type { AlwaysTransition, AnySlot, Machine } from "../machine.js";
import { addAlwaysTransition } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionResult } from "../internal/types.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

/**
 * A single branch in an always transition cascade.
 * Last branch without guard is automatically a fallback.
 */
export interface AlwaysBranch<S, R> {
  readonly guard?: (state: S) => boolean;
  readonly to: (state: S) => TransitionResult<{ readonly _tag: string }, R>;
}

/**
 * Branch type for always transitions
 */
export type AlwaysEntry<S, R> = AlwaysBranch<S, R>;

/**
 * Define eventless (always) transitions with guard cascade.
 * These transitions are evaluated immediately on state entry.
 * First guard to pass wins; last branch without guard is the fallback.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<State, Event>(State.Calculating({ value: 75 })),
 *   always(State.Calculating, [
 *     { guard: (s) => s.value >= 70, to: (s) => State.High(s) },
 *     { guard: (s) => s.value >= 40, to: (s) => State.Medium(s) },
 *     { to: (s) => State.Low(s) },  // Fallback (no guard)
 *   ]),
 * )
 * ```
 */
export function always<NarrowedState extends BrandedState, R2 = never>(
  stateConstructor: { (...args: never[]): NarrowedState },
  branches: ReadonlyArray<AlwaysEntry<NarrowedState, R2>>,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R | R2, Slots> => {
    // Cast needed: addAlwaysTransition has invariant State/Event params but we need covariance here
    let result = builder as Machine<State, Event, R | R2, Slots>;

    for (const branch of branches) {
      // A branch is a fallback if it has no guard
      const isFallback = branch.guard === undefined;

      const transition: AlwaysTransition<State, R | R2> = {
        stateTag,
        handler: branch.to as unknown as (state: State) => TransitionResult<State, R | R2>,
        guard: isFallback
          ? undefined
          : (branch.guard as unknown as ((state: State) => boolean) | undefined),
      };

      result = addAlwaysTransition(transition)(
        result as unknown as Machine<State, BrandedEvent, R | R2, Slots>,
      ) as unknown as Machine<State, Event, R | R2, Slots>;
    }

    return result;
  };
}
