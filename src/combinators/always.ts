import type { AlwaysTransition, MachineBuilder } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionResult } from "../internal/types.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * A single branch in an always transition cascade
 */
export interface AlwaysBranch<S, R> {
  readonly guard?: (state: S) => boolean;
  readonly to: (state: S) => TransitionResult<{ readonly _tag: string }, R>;
  /** @deprecated Last branch without guard is automatically a fallback */
  readonly otherwise?: true;
}

/**
 * @deprecated Use AlwaysBranch without guard for fallback
 */
export interface AlwaysOtherwise<S, R> {
  readonly otherwise: true;
  readonly to: (state: S) => TransitionResult<{ readonly _tag: string }, R>;
  readonly guard?: never;
}

/**
 * Branch type for always transitions
 */
export type AlwaysEntry<S, R> = AlwaysBranch<S, R> | AlwaysOtherwise<S, R>;

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

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: MachineBuilder<State, Event, R, Effects>,
  ): MachineBuilder<State, Event, R | R2, Effects> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: MachineBuilder<State, Event, any, Effects> = builder;

    for (const branch of branches) {
      // A branch is a fallback if:
      // - It has `otherwise: true` (deprecated)
      // - It has no guard
      const isFallback =
        ("otherwise" in branch && branch.otherwise === true) || branch.guard === undefined;

      const transition: AlwaysTransition<State, R2> = {
        stateTag,
        handler: branch.to as unknown as (state: State) => TransitionResult<State, R2>,
        guard: isFallback
          ? undefined
          : (branch.guard as unknown as ((state: State) => boolean) | undefined),
      };

      result = {
        ...result,
        alwaysTransitions: [
          ...result.alwaysTransitions,
          transition as AlwaysTransition<State, R | R2>,
        ],
      };
    }

    return result as MachineBuilder<State, Event, R | R2, Effects>;
  };
}
