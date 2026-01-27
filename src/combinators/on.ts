import type { Effect } from "effect";

import type { AnySlot, EffectSlotType, Machine, OnOptions, Transition } from "../machine.js";
import { addEffectSlot, addTransition, normalizeOnOptions } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";
import type { StateMatcher } from "./any.js";
import { isStateMatcher } from "./any.js";
import type { ScopedTransition } from "./from.js";

// ============================================================================
// Type helpers
// ============================================================================

import type { BrandedState, BrandedEvent, TaggedOrConstructor } from "../internal/brands.js";

/** Check if value is a tagged value or constructor (has _tag property) */
const isTagged = (x: unknown): boolean =>
  (typeof x === "object" && x !== null && "_tag" in x) || (typeof x === "function" && "_tag" in x);

// ============================================================================
// Overload signatures
// ============================================================================

/**
 * Scoped on: event-only signature for use inside `from().pipe()`
 *
 * When called with just (Event, handler), returns a ScopedTransition.
 * The State type parameter must be explicitly provided or inferred from from().pipe().
 */
function onImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2>;

/**
 * Multi-state on: StateMatcher signature for `any(State1, State2, ...)`
 */
function onImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R | R2, Slots>;

/**
 * Standard on: state + event signature
 */
function onImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  state: TaggedOrConstructor<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R | R2, Slots>;

// ============================================================================
// Implementation
// ============================================================================

function onImpl(first: unknown, second: unknown, third?: unknown, fourth?: unknown): unknown {
  // StateMatcher on: first arg has _tag: "StateMatcher"
  if (isStateMatcher(first)) {
    return matcherOnImpl(
      first as StateMatcher<BrandedState>,
      second as TaggedOrConstructor<BrandedEvent>,
      third as (
        ctx: TransitionContext<BrandedState, BrandedEvent>,
      ) => TransitionResult<BrandedState, unknown>,
      fourth as OnOptions<BrandedState, BrandedEvent, unknown> | undefined,
    );
  }

  // Scoped on: first is tagged (event), second is handler function
  // Detected by: second is a function but NOT tagged (it's the handler)
  if (isTagged(first) && typeof second === "function" && !isTagged(second)) {
    return scopedOnImpl(
      first as TaggedOrConstructor<BrandedEvent>,
      second as (
        ctx: TransitionContext<BrandedState, BrandedEvent>,
      ) => TransitionResult<BrandedState, unknown>,
      third as OnOptions<BrandedState, BrandedEvent, unknown> | undefined,
    );
  }

  // Standard on: first (state) and second (event) are both tagged
  return standardOnImpl(
    first as TaggedOrConstructor<BrandedState>,
    second as TaggedOrConstructor<BrandedEvent>,
    third as (
      ctx: TransitionContext<BrandedState, BrandedEvent>,
    ) => TransitionResult<BrandedState, unknown>,
    fourth as OnOptions<BrandedState, BrandedEvent, unknown> | undefined,
  );
}

/**
 * Standard on implementation (state + event)
 */
function standardOnImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  state: TaggedOrConstructor<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const stateTag = getTag(state);
  const eventTag = getTag(event);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R | R2, Slots> => {
    const transition: Transition<State, Event, R2> = {
      stateTag,
      eventTag,
      handler: handler as unknown as (
        ctx: TransitionContext<State, Event>,
      ) => TransitionResult<State, R2>,
      guard: normalizedOptions?.guard as Transition<State, Event, R2>["guard"],
      guardName: normalizedOptions?.guardName,
      guardNeedsProvision: normalizedOptions?.guardNeedsProvision,
      effect: normalizedOptions?.effect as unknown as
        | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
        | undefined,
      reenter: normalizedOptions?.reenter,
    };

    // If guard needs provision, add a guard slot
    let result = addTransition(transition)(builder) as Machine<State, Event, R | R2, Slots>;

    if (
      normalizedOptions?.guardNeedsProvision === true &&
      normalizedOptions.guardName !== undefined
    ) {
      result = addEffectSlot<State, Event, R | R2, EffectSlotType<"guard", string>>({
        type: "guard",
        stateTag,
        eventTag,
        name: normalizedOptions.guardName,
      })(result) as Machine<State, Event, R | R2, Slots>;
    }

    return result;
  };
}

/**
 * StateMatcher on implementation - creates one transition per matched state
 */
function matcherOnImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const eventTag = getTag(event);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R | R2, Slots> => {
    let result = builder as Machine<State, Event, R | R2, Slots>;

    for (const stateTag of matcher.stateTags) {
      const transition: Transition<State, Event, R2> = {
        stateTag,
        eventTag,
        handler: handler as unknown as (
          ctx: TransitionContext<State, Event>,
        ) => TransitionResult<State, R2>,
        guard: normalizedOptions?.guard as Transition<State, Event, R2>["guard"],
        guardName: normalizedOptions?.guardName,
        guardNeedsProvision: normalizedOptions?.guardNeedsProvision,
        effect: normalizedOptions?.effect as unknown as
          | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
          | undefined,
        reenter: normalizedOptions?.reenter,
      };

      result = addTransition(transition)(result) as Machine<State, Event, R | R2, Slots>;
    }

    // If guard needs provision, add a guard slot (only once, not per state)
    if (
      normalizedOptions?.guardNeedsProvision === true &&
      normalizedOptions.guardName !== undefined
    ) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- stateTags is non-empty from any()
      const firstStateTag = matcher.stateTags[0]!;
      result = addEffectSlot<State, Event, R | R2, EffectSlotType<"guard", string>>({
        type: "guard",
        stateTag: firstStateTag,
        eventTag,
        name: normalizedOptions.guardName,
      })(result) as Machine<State, Event, R | R2, Slots>;
    }

    return result;
  };
}

/**
 * Scoped on implementation (event-only, for use inside from().pipe())
 * Exported for reuse in from.ts
 */
export function scopedOnImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> {
  const eventTag = getTag(event);
  const normalizedOptions = normalizeOnOptions(options);

  return {
    _tag: "ScopedTransition",
    eventTag,
    handler: handler as unknown as ScopedTransition<NarrowedState, NarrowedEvent, R2>["handler"],
    guard: normalizedOptions?.guard as ScopedTransition<NarrowedState, NarrowedEvent, R2>["guard"],
    guardName: normalizedOptions?.guardName,
    guardNeedsProvision: normalizedOptions?.guardNeedsProvision,
    effect: normalizedOptions?.effect as ScopedTransition<
      NarrowedState,
      NarrowedEvent,
      R2
    >["effect"],
    reenter: normalizedOptions?.reenter,
  };
}

// ============================================================================
// on.force
// ============================================================================

/**
 * Options for on.force (no reenter option since it's always true)
 */
export interface OnForceOptions<S, E, R> {
  readonly guard?: OnOptions<S, E, R>["guard"];
  readonly effect?: OnOptions<S, E, R>["effect"];
}

/**
 * Scoped on.force: event-only signature for use inside `from().pipe()`
 */
function forceImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2>;

/**
 * Multi-state on.force: StateMatcher signature
 */
function forceImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R | R2, Slots>;

/**
 * Standard on.force: state + event signature
 */
function forceImpl<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  ResultState extends BrandedState,
  R2 = never,
>(
  state: TaggedOrConstructor<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R | R2, Slots>;

function forceImpl(first: unknown, second: unknown, third?: unknown, fourth?: unknown): unknown {
  // Re-use on() logic with reenter: true forced
  // Same dispatch logic as onImpl
  if (isStateMatcher(first)) {
    return onImpl(first as never, second as never, third as never, {
      ...(fourth as object),
      reenter: true,
    });
  }

  if (isTagged(first) && typeof second === "function" && !isTagged(second)) {
    return onImpl(first as never, second as never, { ...(third as object), reenter: true });
  }

  return onImpl(first as never, second as never, third as never, {
    ...(fourth as object),
    reenter: true,
  });
}

/**
 * Define a transition from one state to another on an event.
 *
 * Supports three signatures:
 * - `on(State, Event, handler)` - standard state + event
 * - `on(any(State1, State2), Event, handler)` - multi-state matcher
 * - `on(Event, handler)` - event-only for use inside `from().pipe()`
 *
 * Use `on.force()` to force exit/enter effects even on same-state transitions.
 *
 * @example Standard usage
 * ```ts
 * Machine.make<State, Event>(State.Idle()).pipe(
 *   Machine.on(State.Idle, Event.Start, () => State.Running()),
 * )
 * ```
 *
 * @example Multi-state with any()
 * ```ts
 * Machine.make<State, Event>(State.Idle()).pipe(
 *   Machine.on(
 *     Machine.any(State.Running, State.Paused),
 *     Event.Stop,
 *     () => State.Stopped()
 *   ),
 * )
 * ```
 *
 * @example Scoped with from()
 * ```ts
 * Machine.make<State, Event>(State.Idle()).pipe(
 *   Machine.from(State.Typing).pipe(
 *     Machine.on(Event.KeyPress, h1),
 *     Machine.on(Event.Submit, h2),
 *   ),
 * )
 * ```
 */
export const on = Object.assign(onImpl, { force: forceImpl });
