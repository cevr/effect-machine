import type { AlwaysTransition, MachineBuilder } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionResult } from "../internal/types.js";

/**
 * A single branch in an always transition cascade
 */
export interface AlwaysBranch<S, R> {
  readonly guard?: (state: S) => boolean;
  readonly to: (state: S) => TransitionResult<{ readonly _tag: string }, R>;
  readonly otherwise?: never;
}

/**
 * The fallback branch (no guard required)
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
 * First guard to pass wins; `otherwise: true` matches unconditionally.
 *
 * @example Single always transition
 * ```ts
 * pipe(
 *   Machine.make<State, Event>(State.Calculating({ value: 75 })),
 *   always(State.Calculating, [
 *     { guard: (s) => s.value >= 70, to: (s) => State.High(s) },
 *     { guard: (s) => s.value >= 40, to: (s) => State.Medium(s) },
 *     { otherwise: true, to: (s) => State.Low(s) },
 *   ]),
 * )
 * ```
 */
export function always<NarrowedState extends { readonly _tag: string }, R2 = never>(
  stateConstructor: { (...args: never[]): NarrowedState },
  branches: ReadonlyArray<AlwaysEntry<NarrowedState, R2>>,
) {
  const stateTag = getTag(stateConstructor);

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    // Convert each branch to an AlwaysTransition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: MachineBuilder<State, Event, any> = builder;

    for (const branch of branches) {
      const transition: AlwaysTransition<State, R2> = {
        stateTag,
        handler: branch.to as unknown as (state: State) => TransitionResult<State, R2>,
        guard:
          "otherwise" in branch && branch.otherwise === true
            ? undefined // otherwise always matches
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

    return result as MachineBuilder<State, Event, R | R2>;
  };
}
