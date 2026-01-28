import type { TransitionContext } from "../internal/types.js";

/**
 * Create a handler function that merges partial updates into the current state.
 * Useful for updating state without changing the state tag.
 *
 * @example
 * ```ts
 * machine.on(State.Form, Event.SetName, Machine.assign(({ event }) => ({ name: event.name })))
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
