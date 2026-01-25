import type { Effect } from "effect";

import type { MachineBuilder, Transition } from "../machine.js";
import { addTransition } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";

/**
 * A single branch in a choose transition cascade
 */
export interface ChooseBranch<S, E, R> {
  readonly guard: (ctx: TransitionContext<S, E>) => boolean;
  readonly to: (ctx: TransitionContext<S, E>) => TransitionResult<{ readonly _tag: string }, R>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  readonly otherwise?: never;
}

/**
 * The fallback branch (no guard required)
 */
export interface ChooseOtherwise<S, E, R> {
  readonly otherwise: true;
  readonly to: (ctx: TransitionContext<S, E>) => TransitionResult<{ readonly _tag: string }, R>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  readonly guard?: never;
}

/**
 * Branch type for choose transitions
 */
export type ChooseEntry<S, E, R> = ChooseBranch<S, E, R> | ChooseOtherwise<S, E, R>;

/**
 * Define multiple guarded transitions for the same state/event pair.
 * Evaluates guards in order; first to pass wins.
 * Use `otherwise: true` for the fallback branch.
 *
 * This is syntactic sugar that leverages guard cascade -
 * each branch becomes a separate transition in registration order.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<State, Event>(State.Idle({ value: 75 })),
 *   choose(State.Idle, Event.Check, [
 *     { guard: ({ state }) => state.value >= 70, to: ({ state }) => State.High(state) },
 *     { guard: ({ state }) => state.value >= 40, to: ({ state }) => State.Medium(state) },
 *     { otherwise: true, to: ({ state }) => State.Low(state) },
 *   ]),
 * )
 * ```
 */
export function choose<
  NarrowedState extends { readonly _tag: string },
  NarrowedEvent extends { readonly _tag: string },
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  eventConstructor: { (...args: never[]): NarrowedEvent },
  branches: ReadonlyArray<ChooseEntry<NarrowedState, NarrowedEvent, R2>>,
) {
  const stateTag = getTag(stateConstructor);
  const eventTag = getTag(eventConstructor);

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    // Each branch becomes a separate transition, leveraging guard cascade
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: MachineBuilder<State, Event, any> = builder;

    for (const branch of branches) {
      const transition: Transition<State, Event, R2> = {
        stateTag,
        eventTag,
        handler: branch.to as unknown as (
          ctx: TransitionContext<State, Event>,
        ) => TransitionResult<State, R2>,
        guard:
          "otherwise" in branch && branch.otherwise === true
            ? undefined // otherwise always matches
            : (branch.guard as unknown as
                | ((ctx: TransitionContext<State, Event>) => boolean)
                | undefined),
        effect: branch.effect as unknown as
          | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
          | undefined,
      };

      result = addTransition(transition)(result);
    }

    return result as MachineBuilder<State, Event, R | R2>;
  };
}
