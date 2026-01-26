import type { Effect } from "effect";

import { getTag } from "../internal/get-tag.js";
import type { MachineBuilder, OnOptions, Transition } from "../machine.js";
import { addTransition, normalizeOnOptions } from "../machine.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";

/**
 * A partial transition created inside `from().pipe()` - missing the stateTag
 */
export interface ScopedTransition<State, Event, R> {
  readonly _tag: "ScopedTransition";
  readonly eventTag: string;
  readonly handler: (ctx: TransitionContext<State, Event>) => TransitionResult<State, R>;
  readonly guard?: (ctx: TransitionContext<State, Event>) => boolean;
  readonly guardName?: string;
  readonly effect?: (ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R>;
  readonly reenter?: boolean;
}

/**
 * A scoped state context that provides event-only `on` calls.
 * Use `.pipe()` with scoped `on(Event, handler)` calls.
 */
export interface StateScope<NarrowedState extends { readonly _tag: string }> {
  readonly _tag: "StateScope";
  readonly stateTag: string;

  /**
   * Pipe scoped transitions (event-only on() calls) and return a builder transform
   */
  pipe<E1 extends { readonly _tag: string }, R1>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1>;

  pipe<E1 extends { readonly _tag: string }, R1, E2 extends { readonly _tag: string }, R2>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1 | R2>;

  pipe<
    E1 extends { readonly _tag: string },
    R1,
    E2 extends { readonly _tag: string },
    R2,
    E3 extends { readonly _tag: string },
    R3,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1 | R2 | R3>;

  pipe<
    E1 extends { readonly _tag: string },
    R1,
    E2 extends { readonly _tag: string },
    R2,
    E3 extends { readonly _tag: string },
    R3,
    E4 extends { readonly _tag: string },
    R4,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1 | R2 | R3 | R4>;

  pipe<
    E1 extends { readonly _tag: string },
    R1,
    E2 extends { readonly _tag: string },
    R2,
    E3 extends { readonly _tag: string },
    R3,
    E4 extends { readonly _tag: string },
    R4,
    E5 extends { readonly _tag: string },
    R5,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
    t5: ScopedTransition<NarrowedState, E5, R5>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5>;

  pipe<
    E1 extends { readonly _tag: string },
    R1,
    E2 extends { readonly _tag: string },
    R2,
    E3 extends { readonly _tag: string },
    R3,
    E4 extends { readonly _tag: string },
    R4,
    E5 extends { readonly _tag: string },
    R5,
    E6 extends { readonly _tag: string },
    R6,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
    t5: ScopedTransition<NarrowedState, E5, R5>,
    t6: ScopedTransition<NarrowedState, E6, R6>,
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5 | R6>;

  // Fallback for more than 6 transitions
  pipe(
    ...transitions: Array<ScopedTransition<NarrowedState, { readonly _tag: string }, unknown>>
  ): <FullState extends { readonly _tag: string }, FullEvent extends { readonly _tag: string }, R>(
    builder: MachineBuilder<FullState, FullEvent, R>,
  ) => MachineBuilder<FullState, FullEvent, R | unknown>;
}

/**
 * Implementation of StateScope.pipe
 */
function stateScopePipe<NarrowedState extends { readonly _tag: string }>(
  this: StateScope<NarrowedState>,
  ...transitions: Array<ScopedTransition<NarrowedState, { readonly _tag: string }, unknown>>
): <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  builder: MachineBuilder<S, E, R>,
) => MachineBuilder<S, E, unknown> {
  const stateTag = this.stateTag;

  return <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    builder: MachineBuilder<S, E, R>,
  ): MachineBuilder<S, E, unknown> => {
    let result: MachineBuilder<S, E, unknown> = builder;
    for (const scopedTransition of transitions) {
      const transition: Transition<S, E, unknown> = {
        stateTag,
        eventTag: scopedTransition.eventTag,
        handler: scopedTransition.handler as unknown as Transition<S, E, unknown>["handler"],
        guard: scopedTransition.guard as unknown as Transition<S, E, unknown>["guard"],
        guardName: scopedTransition.guardName,
        effect: scopedTransition.effect as unknown as Transition<S, E, unknown>["effect"],
        reenter: scopedTransition.reenter,
      };
      result = addTransition(transition)(result);
    }
    return result;
  };
}

/**
 * Scope transitions to a specific state, allowing event-only `on` calls.
 *
 * @example
 * ```ts
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.from(State.Typing).pipe(
 *     Machine.on(Event.KeyPress, ({ state, event }) => State.Typing({ text: state.text + event.key })),
 *     Machine.on(Event.Backspace, ({ state }) => State.Typing({ text: state.text.slice(0, -1) })),
 *     Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
 *   ),
 * )
 * ```
 */
export const from = <NarrowedState extends { readonly _tag: string }>(stateConstructor: {
  (...args: never[]): NarrowedState;
}): StateScope<NarrowedState> => {
  const scope: StateScope<NarrowedState> = {
    _tag: "StateScope",
    stateTag: getTag(stateConstructor),
    pipe: stateScopePipe,
  };
  return scope;
};

/**
 * Create a scoped transition (event-only) for use inside `from().pipe()`.
 * This is an internal helper - use `on` which auto-detects scoped vs full context.
 */
export const scopedOn = <
  NarrowedState extends { readonly _tag: string },
  NarrowedEvent extends { readonly _tag: string },
  ResultState extends { readonly _tag: string },
  R2 = never,
>(
  eventConstructor: { (...args: never[]): NarrowedEvent },
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> => {
  const eventTag = getTag(eventConstructor);
  const normalizedOptions = normalizeOnOptions(options);

  return {
    _tag: "ScopedTransition",
    eventTag,
    handler: handler as unknown as ScopedTransition<NarrowedState, NarrowedEvent, R2>["handler"],
    guard: normalizedOptions?.guard as ScopedTransition<NarrowedState, NarrowedEvent, R2>["guard"],
    guardName: normalizedOptions?.guardName,
    effect: normalizedOptions?.effect as ScopedTransition<
      NarrowedState,
      NarrowedEvent,
      R2
    >["effect"],
    reenter: normalizedOptions?.reenter,
  };
};

/**
 * Force variant for scoped transitions
 */
export const scopedOnForce = <
  NarrowedState extends { readonly _tag: string },
  NarrowedEvent extends { readonly _tag: string },
  ResultState extends { readonly _tag: string },
  R2 = never,
>(
  eventConstructor: { (...args: never[]): NarrowedEvent },
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: Omit<OnOptions<NarrowedState, NarrowedEvent, R2>, "reenter">,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> =>
  scopedOn(eventConstructor, handler, { ...options, reenter: true });
