import type { Effect } from "effect";

import type { MachineBuilder, OnOptions, Transition } from "../machine.js";
import { addTransition, normalizeOnOptions } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { TransitionContext } from "../internal/types.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Create a handler function that merges partial updates into the current state.
 * Useful for updating state without changing the state tag.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FormState, FormEvent>(State.Form({ name: "", email: "" })),
 *   on(State.Form, Event.SetName, assign(({ event }) => ({ name: event.name }))),
 *   on(State.Form, Event.SetEmail, assign(({ event }) => ({ email: event.email }))),
 * )
 * ```
 */
export function assign<S extends { readonly _tag: string }, E>(
  updater: (ctx: TransitionContext<S, E>) => Partial<Omit<S, "_tag">>,
): (ctx: TransitionContext<S, E>) => S {
  return (ctx) => ({
    ...ctx.state,
    ...updater(ctx),
  });
}

/**
 * Shorthand for `on(State, Event, assign(...))`.
 * Updates the current state by merging partial data without changing the tag.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FormState, FormEvent>(State.Form({ name: "", email: "" })),
 *   update(State.Form, Event.SetName, ({ event }) => ({ name: event.name })),
 *   update(State.Form, Event.SetEmail, ({ event }) => ({ email: event.email })),
 * )
 * ```
 */
export function update<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  eventConstructor: { (...args: never[]): NarrowedEvent },
  updater: (
    ctx: TransitionContext<NarrowedState, NarrowedEvent>,
  ) => Partial<Omit<NarrowedState, "_tag">>,
  options?: OnOptions<NarrowedState, NarrowedEvent, R2>,
) {
  const stateTag = getTag(stateConstructor);
  const eventTag = getTag(eventConstructor);
  const normalizedOptions = normalizeOnOptions(options);

  return <State extends BrandedState, Event extends BrandedEvent, R, Effects extends string>(
    builder: MachineBuilder<State, Event, R, Effects>,
  ): MachineBuilder<State, Event, R | R2, Effects> => {
    const transition: Transition<State, Event, R2> = {
      stateTag,
      eventTag,
      handler: (ctx) => ({
        ...ctx.state,
        ...updater(ctx as unknown as TransitionContext<NarrowedState, NarrowedEvent>),
      }),
      guard: normalizedOptions?.guard as unknown as
        | ((ctx: TransitionContext<State, Event>) => boolean)
        | undefined,
      effect: normalizedOptions?.effect as unknown as
        | ((ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R2>)
        | undefined,
    };

    return addTransition(transition)(builder) as MachineBuilder<State, Event, R | R2, Effects>;
  };
}
