import { Effect, Fiber } from "effect";

import type { MachineBuilder, StateEffect } from "../machine.js";
import { addOnEnter, addOnExit } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { StateEffectContext } from "../internal/types.js";

/**
 * Invoke an effect when entering a state, automatically cancelling it on exit.
 * Handler receives a context object with { state, self }.
 *
 * @example
 * ```ts
 * pipe(
 *   Machine.make<FetcherState, FetcherEvent>(State.Idle({})),
 *   invoke(State.Loading, ({ state, self }) =>
 *     pipe(
 *       Effect.tryPromise(() => fetch(state.url).then(r => r.json())),
 *       Effect.map((data) => Event._Done({ data })),
 *       Effect.catchAll((e) => Effect.succeed(Event._Error({ error: String(e) }))),
 *       Effect.flatMap(self.send)
 *     )
 *   )
 * )
 * ```
 */
export function invoke<
  NarrowedState extends { readonly _tag: string },
  EventType extends { readonly _tag: string },
  R2 = never,
>(
  stateConstructor: { (...args: never[]): NarrowedState },
  handler: (ctx: StateEffectContext<NarrowedState, EventType>) => Effect.Effect<void, never, R2>,
) {
  const stateTag = getTag(stateConstructor);

  // Store the fiber ref for cleanup
  let activeFiber: Fiber.RuntimeFiber<void, never> | null = null;

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    const enterEffect: StateEffect<State, Event, R2> = {
      stateTag,
      handler: (ctx) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            handler(ctx as unknown as StateEffectContext<NarrowedState, EventType>),
          );
          activeFiber = fiber;
        }),
    };

    const exitEffect: StateEffect<State, Event, R2> = {
      stateTag,
      handler: () =>
        Effect.suspend(() => {
          if (activeFiber) {
            const fiber = activeFiber;
            activeFiber = null;
            return Fiber.interrupt(fiber).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
    };

    const b1 = addOnEnter(enterEffect)(builder) as MachineBuilder<State, Event, R | R2>;
    return addOnExit(exitEffect)(b1) as MachineBuilder<State, Event, R | R2>;
  };
}
