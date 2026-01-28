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
  updater: (ctx: { readonly state: S; readonly event: E }) => Partial<Omit<S, "_tag">>,
): (ctx: { readonly state: S; readonly event: E }) => S {
  return (ctx) => ({
    ...ctx.state,
    ...updater(ctx),
  });
}
