import type { Effect } from "effect";

import { getTag } from "../internal/get-tag.js";
import type { Machine, OnOptions, Transition } from "../machine.js";
import { addTransition, normalizeOnOptions } from "../machine.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

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
export interface StateScope<NarrowedState extends BrandedState> {
  readonly _tag: "StateScope";
  readonly stateTag: string;

  /**
   * Pipe scoped transitions (event-only on() calls) and return a builder transform
   */
  pipe<E1 extends BrandedEvent, R1>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1, Effects>;

  pipe<E1 extends BrandedEvent, R1, E2 extends BrandedEvent, R2>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1 | R2, Effects>;

  pipe<E1 extends BrandedEvent, R1, E2 extends BrandedEvent, R2, E3 extends BrandedEvent, R3>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3, Effects>;

  pipe<
    E1 extends BrandedEvent,
    R1,
    E2 extends BrandedEvent,
    R2,
    E3 extends BrandedEvent,
    R3,
    E4 extends BrandedEvent,
    R4,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4, Effects>;

  pipe<
    E1 extends BrandedEvent,
    R1,
    E2 extends BrandedEvent,
    R2,
    E3 extends BrandedEvent,
    R3,
    E4 extends BrandedEvent,
    R4,
    E5 extends BrandedEvent,
    R5,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
    t5: ScopedTransition<NarrowedState, E5, R5>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5, Effects>;

  pipe<
    E1 extends BrandedEvent,
    R1,
    E2 extends BrandedEvent,
    R2,
    E3 extends BrandedEvent,
    R3,
    E4 extends BrandedEvent,
    R4,
    E5 extends BrandedEvent,
    R5,
    E6 extends BrandedEvent,
    R6,
  >(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
    t4: ScopedTransition<NarrowedState, E4, R4>,
    t5: ScopedTransition<NarrowedState, E5, R5>,
    t6: ScopedTransition<NarrowedState, E6, R6>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5 | R6, Effects>;

  // Fallback for more than 6 transitions
  pipe(
    ...transitions: Array<ScopedTransition<NarrowedState, BrandedEvent, unknown>>
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Effects extends string>(
    builder: Machine<FullState, FullEvent, R, Effects>,
  ) => Machine<FullState, FullEvent, R | unknown, Effects>;
}

/**
 * Implementation of StateScope.pipe
 */
function stateScopePipe<NarrowedState extends BrandedState>(
  this: StateScope<NarrowedState>,
  ...transitions: Array<ScopedTransition<NarrowedState, BrandedEvent, unknown>>
): <S extends BrandedState, E extends BrandedEvent, R, Effects extends string>(
  builder: Machine<S, E, R, Effects>,
) => Machine<S, E, unknown, Effects> {
  const stateTag = this.stateTag;

  return <S extends BrandedState, E extends BrandedEvent, R, Effects extends string>(
    builder: Machine<S, E, R, Effects>,
  ): Machine<S, E, unknown, Effects> => {
    let result: Machine<S, E, unknown, Effects> = builder;
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
export const from = <NarrowedState extends BrandedState>(stateConstructor: {
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
 *
 * @internal
 */
export const scopedOn = <
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
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
 *
 * @internal
 */
export const scopedOnForce = <
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  eventConstructor: { (...args: never[]): NarrowedEvent },
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: Omit<OnOptions<NarrowedState, NarrowedEvent, R2>, "reenter">,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> =>
  scopedOn(eventConstructor, handler, { ...options, reenter: true });
