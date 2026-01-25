import { Effect, Fiber } from "effect";

import type { MachineBuilder, MachineRef, StateEffect } from "../machine.js";
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

  // Unique key for this invoke instance within the state
  const invokeKey = Symbol("invoke");

  return <State extends { readonly _tag: string }, Event extends { readonly _tag: string }, R>(
    builder: MachineBuilder<State, Event, R>,
  ): MachineBuilder<State, Event, R | R2> => {
    // Per-actor, per-invoke fiber storage
    const actorInvokeFibers = new WeakMap<
      MachineRef<unknown>,
      Map<symbol, Fiber.RuntimeFiber<void, never>>
    >();

    const getFiberMap = (self: MachineRef<Event>): Map<symbol, Fiber.RuntimeFiber<void, never>> => {
      const key = self as MachineRef<unknown>;
      let map = actorInvokeFibers.get(key);
      if (map === undefined) {
        map = new Map();
        actorInvokeFibers.set(key, map);
      }
      return map;
    };

    const enterEffect: StateEffect<State, Event, R2> = {
      stateTag,
      handler: (ctx) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.fork(
            handler(ctx as unknown as StateEffectContext<NarrowedState, EventType>),
          );
          getFiberMap(ctx.self).set(invokeKey, fiber);
        }),
    };

    const exitEffect: StateEffect<State, Event, R2> = {
      stateTag,
      handler: ({ self }) =>
        Effect.suspend(() => {
          const fiberMap = getFiberMap(self);
          const fiber = fiberMap.get(invokeKey);
          if (fiber !== undefined) {
            fiberMap.delete(invokeKey);
            return Fiber.interrupt(fiber).pipe(Effect.asVoid);
          }
          return Effect.void;
        }),
    };

    const b1 = addOnEnter(enterEffect)(builder) as MachineBuilder<State, Event, R | R2>;
    return addOnExit(exitEffect)(b1) as MachineBuilder<State, Event, R | R2>;
  };
}
