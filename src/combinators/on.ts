import type { Effect } from "effect";

import type { MachineBuilder, OnOptions, Transition } from "../machine.js";
import { addTransition, normalizeOnOptions } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionContext, TransitionResult } from "../internal/types.js";
import type { StateMatcher } from "./any.js";
import { isStateMatcher } from "./any.js";
import type { ScopedTransition } from "./from.js";

// ============================================================================
// Type helpers
// ============================================================================

type TaggedState = { readonly _tag: string };
type TaggedEvent = { readonly _tag: string };
type Constructor<T extends TaggedState | TaggedEvent> = { (...args: never[]): T };

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
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2>;

/**
 * Multi-state on: StateMatcher signature for `any(State1, State2, ...)`
 */
function onImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends TaggedState, Event extends TaggedEvent, R>(
  builder: MachineBuilder<State, Event, R>,
) => MachineBuilder<State, Event, R | R2>;

/**
 * Standard on: state + event signature
 */
function onImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  stateConstructor: Constructor<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends TaggedState, Event extends TaggedEvent, R>(
  builder: MachineBuilder<State, Event, R>,
) => MachineBuilder<State, Event, R | R2>;

// ============================================================================
// Implementation
// ============================================================================

function onImpl(first: unknown, second: unknown, third?: unknown, fourth?: unknown): unknown {
  // Scoped on: first arg is event constructor (function), second is handler (function)
  // We detect this by checking if second is a function and third is undefined or options object
  if (
    typeof first === "function" &&
    typeof second === "function" &&
    (third === undefined || (typeof third === "object" && third !== null && !("_tag" in third)))
  ) {
    return scopedOnImpl(
      first as Constructor<TaggedEvent>,
      second as (
        ctx: TransitionContext<TaggedState, TaggedEvent>,
      ) => TransitionResult<TaggedState, unknown>,
      third as OnOptions<TaggedState, TaggedEvent, unknown> | undefined,
    );
  }

  // StateMatcher on: first arg has _tag: "StateMatcher"
  if (isStateMatcher(first)) {
    return matcherOnImpl(
      first,
      second as Constructor<TaggedEvent>,
      third as (
        ctx: TransitionContext<TaggedState, TaggedEvent>,
      ) => TransitionResult<TaggedState, unknown>,
      fourth as OnOptions<TaggedState, TaggedEvent, unknown> | undefined,
    );
  }

  // Standard on: first and second are both constructors
  return standardOnImpl(
    first as Constructor<TaggedState>,
    second as Constructor<TaggedEvent>,
    third as (
      ctx: TransitionContext<TaggedState, TaggedEvent>,
    ) => TransitionResult<TaggedState, unknown>,
    fourth as OnOptions<TaggedState, TaggedEvent, unknown> | undefined,
  );
}

/**
 * Standard on implementation (state + event)
 */
function standardOnImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  stateConstructor: Constructor<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const stateTag = getTag(stateConstructor);
  const eventTag = getTag(eventConstructor);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends TaggedState, Event extends TaggedEvent, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    const transition: Transition<State, Event, R2> = {
      stateTag,
      eventTag,
      handler: handler as unknown as (
        ctx: TransitionContext<State, Event>,
      ) => TransitionResult<State, R2>,
      guard: normalizedOptions?.guard as unknown as
        | ((ctx: TransitionContext<State, Event>) => boolean)
        | undefined,
      guardName: normalizedOptions?.guardName,
      effect: normalizedOptions?.effect as unknown as
        | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
        | undefined,
      reenter: normalizedOptions?.reenter,
    };

    return addTransition(transition)(builder) as MachineBuilder<State, Event, R | R2>;
  };
}

/**
 * StateMatcher on implementation - creates one transition per matched state
 */
function matcherOnImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const eventTag = getTag(eventConstructor);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends TaggedState, Event extends TaggedEvent, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    let result = builder as MachineBuilder<State, Event, R | R2>;

    for (const stateTag of matcher.stateTags) {
      const transition: Transition<State, Event, R2> = {
        stateTag,
        eventTag,
        handler: handler as unknown as (
          ctx: TransitionContext<State, Event>,
        ) => TransitionResult<State, R2>,
        guard: normalizedOptions?.guard as unknown as
          | ((ctx: TransitionContext<State, Event>) => boolean)
          | undefined,
        guardName: normalizedOptions?.guardName,
        effect: normalizedOptions?.effect as unknown as
          | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
          | undefined,
        reenter: normalizedOptions?.reenter,
      };

      result = addTransition(transition)(result) as MachineBuilder<State, Event, R | R2>;
    }

    return result;
  };
}

/**
 * Scoped on implementation (event-only, for use inside from().pipe())
 */
function scopedOnImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2> {
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
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): ScopedTransition<NarrowedState, NarrowedEvent, R2>;

/**
 * Multi-state on.force: StateMatcher signature
 */
function forceImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  matcher: StateMatcher<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends TaggedState, Event extends TaggedEvent, R>(
  builder: MachineBuilder<State, Event, R>,
) => MachineBuilder<State, Event, R | R2>;

/**
 * Standard on.force: state + event signature
 */
function forceImpl<
  NarrowedState extends TaggedState,
  NarrowedEvent extends TaggedEvent,
  ResultState extends TaggedState,
  R2 = never,
>(
  stateConstructor: Constructor<NarrowedState>,
  eventConstructor: Constructor<NarrowedEvent>,
  handler: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => TransitionResult<ResultState, R2>,
  options?: OnForceOptions<NarrowedState, NarrowedEvent, R2>,
): <State extends TaggedState, Event extends TaggedEvent, R>(
  builder: MachineBuilder<State, Event, R>,
) => MachineBuilder<State, Event, R | R2>;

function forceImpl(first: unknown, second: unknown, third?: unknown, fourth?: unknown): unknown {
  // Re-use on() logic with reenter: true forced
  if (
    typeof first === "function" &&
    typeof second === "function" &&
    (third === undefined || (typeof third === "object" && third !== null && !("_tag" in third)))
  ) {
    return onImpl(first as never, second as never, { ...(third as object), reenter: true });
  }

  if (isStateMatcher(first)) {
    return onImpl(first as never, second as never, third as never, {
      ...(fourth as object),
      reenter: true,
    });
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
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.on(State.Idle, Event.Start, () => State.Running({})),
 * )
 * ```
 *
 * @example Multi-state with any()
 * ```ts
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.on(
 *     Machine.any(State.Running, State.Paused),
 *     Event.Stop,
 *     () => State.Stopped({})
 *   ),
 * )
 * ```
 *
 * @example Scoped with from()
 * ```ts
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.from(State.Typing).pipe(
 *     Machine.on(Event.KeyPress, h1),
 *     Machine.on(Event.Submit, h2),
 *   ),
 * )
 * ```
 */
export const on = Object.assign(onImpl, { force: forceImpl });
