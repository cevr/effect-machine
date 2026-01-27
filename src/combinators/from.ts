import type { Effect } from "effect";

import { getTag } from "../internal/get-tag.js";
import type { AnySlot, EffectSlotType, Machine, OnOptions, Transition } from "../machine.js";
import { addEffectSlot, addTransition } from "../machine.js";
import type { GuardPredicate, TransitionContext, TransitionResult } from "../internal/types.js";
import type { BrandedState, BrandedEvent, TaggedOrConstructor } from "../internal/brands.js";
import { scopedOnImpl } from "./on.js";

/**
 * A partial transition created inside `from().pipe()` - missing the stateTag
 */
export interface ScopedTransition<State, Event, R> {
  readonly _tag: "ScopedTransition";
  readonly eventTag: string;
  readonly handler: (ctx: TransitionContext<State, Event>) => TransitionResult<State, R>;
  readonly guard?: GuardPredicate<State, Event, R>;
  readonly guardName?: string;
  readonly guardNeedsProvision?: boolean;
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
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1, Slots>;

  pipe<E1 extends BrandedEvent, R1, E2 extends BrandedEvent, R2>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1 | R2, Slots>;

  pipe<E1 extends BrandedEvent, R1, E2 extends BrandedEvent, R2, E3 extends BrandedEvent, R3>(
    t1: ScopedTransition<NarrowedState, E1, R1>,
    t2: ScopedTransition<NarrowedState, E2, R2>,
    t3: ScopedTransition<NarrowedState, E3, R3>,
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3, Slots>;

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
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4, Slots>;

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
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5, Slots>;

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
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | R1 | R2 | R3 | R4 | R5 | R6, Slots>;

  // Fallback for more than 6 transitions
  pipe(
    ...transitions: Array<ScopedTransition<NarrowedState, BrandedEvent, unknown>>
  ): <FullState extends BrandedState, FullEvent extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<FullState, FullEvent, R, Slots>,
  ) => Machine<FullState, FullEvent, R | unknown, Slots>;
}

/**
 * Implementation of StateScope.pipe
 */
function stateScopePipe<NarrowedState extends BrandedState>(
  this: StateScope<NarrowedState>,
  ...transitions: Array<ScopedTransition<NarrowedState, BrandedEvent, unknown>>
): <S extends BrandedState, E extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<S, E, R, Slots>,
) => Machine<S, E, unknown, Slots> {
  const stateTag = this.stateTag;

  return <S extends BrandedState, E extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<S, E, R, Slots>,
  ): Machine<S, E, unknown, Slots> => {
    let result: Machine<S, E, unknown, Slots> = builder;
    for (const scopedTransition of transitions) {
      const transition: Transition<S, E, unknown> = {
        stateTag,
        eventTag: scopedTransition.eventTag,
        handler: scopedTransition.handler as unknown as Transition<S, E, unknown>["handler"],
        guard: scopedTransition.guard as unknown as Transition<S, E, unknown>["guard"],
        guardName: scopedTransition.guardName,
        guardNeedsProvision: scopedTransition.guardNeedsProvision,
        effect: scopedTransition.effect as unknown as Transition<S, E, unknown>["effect"],
        reenter: scopedTransition.reenter,
      };
      result = addTransition(transition)(result);

      // If guard needs provision, add a guard slot
      if (
        scopedTransition.guardNeedsProvision === true &&
        scopedTransition.guardName !== undefined
      ) {
        result = addEffectSlot<S, E, unknown, EffectSlotType<"guard", string>>({
          type: "guard",
          stateTag,
          eventTag: scopedTransition.eventTag,
          name: scopedTransition.guardName,
        })(result) as Machine<S, E, unknown, Slots>;
      }
    }
    return result;
  };
}

/**
 * Scope transitions to a specific state, allowing event-only `on` calls.
 *
 * @example
 * ```ts
 * Machine.make<State, Event>(State.Idle()).pipe(
 *   Machine.from(State.Typing).pipe(
 *     Machine.on(Event.KeyPress, ({ state, event }) => State.Typing({ text: state.text + event.key })),
 *     Machine.on(Event.Backspace, ({ state }) => State.Typing({ text: state.text.slice(0, -1) })),
 *     Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
 *   ),
 * )
 * ```
 */
export const from = <NarrowedState extends BrandedState>(
  state: TaggedOrConstructor<NarrowedState>,
): StateScope<NarrowedState> => {
  const scope: StateScope<NarrowedState> = {
    _tag: "StateScope",
    stateTag: getTag(state),
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
export const scopedOn = scopedOnImpl;

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
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: Omit<OnOptions<NarrowedState, NarrowedEvent, R2>, "reenter">,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> =>
  scopedOnImpl(event, handler, { ...options, reenter: true });
