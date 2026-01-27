import { Effect, Fiber } from "effect";

import type { EffectSlot, Machine, MachineRef, StateEffect } from "../machine.js";
import type { StateEffectContext } from "../internal/types.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";
import { pipeArguments } from "effect/Pipeable";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Effect handler function - receives context and returns an effect
 */
export type EffectHandler<State, Event, R> = (
  ctx: StateEffectContext<State, Event>,
) => Effect.Effect<void, never, R>;

/**
 * Type for the handlers record - maps effect slot names to handlers
 */
export type EffectHandlers<State, Event, Effects extends string, R> = {
  [K in Effects]: EffectHandler<State, Event, R>;
};

const PipeableProto = {
  pipe() {
    return pipeArguments(this, arguments);
  },
};

/**
 * Provide effect handlers for all named slots in a machine.
 *
 * This converts a machine with unprovided effect slots into a machine
 * with all effects implemented. The result can be spawned.
 *
 * @example
 * ```ts
 * // Define machine with effect slots
 * const FetchMachine = Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
 *   Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
 *   Machine.invoke(State.Loading, "fetchData"),
 *   Machine.onEnter(State.Success, "notifyUser"),
 *   Machine.onExit(State.Loading, "cleanup"),
 *   Machine.build,
 *   Machine.provide({
 *     fetchData: ({ state, self }) =>
 *       Effect.gen(function* () {
 *         const data = yield* fetchFromApi(state.url)
 *         yield* self.send(Event.Resolve({ data }))
 *       }),
 *     notifyUser: ({ state }) => Effect.log(`Success: ${state.data}`),
 *     cleanup: () => Effect.void,
 *   }),
 * )
 * ```
 */
export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  Effects extends string,
  R2,
>(
  handlers: EffectHandlers<State, Event, Effects, R2>,
): <R>(machine: Machine<State, Event, R, Effects>) => Machine<State, Event, R | R2, never>;

export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Effects extends string,
  R2,
>(
  machine: Machine<State, Event, R, Effects>,
  handlers: EffectHandlers<State, Event, Effects, R2>,
): Machine<State, Event, R | R2, never>;

export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Effects extends string,
  R2,
>(
  machineOrHandlers: Machine<State, Event, R, Effects> | EffectHandlers<State, Event, Effects, R2>,
  handlers?: EffectHandlers<State, Event, Effects, R2>,
):
  | Machine<State, Event, R | R2, never>
  | (<R3>(machine: Machine<State, Event, R3, Effects>) => Machine<State, Event, R3 | R2, never>) {
  // Data-last (curried) form: provide(handlers)
  if (handlers === undefined) {
    const h = machineOrHandlers as EffectHandlers<State, Event, Effects, R2>;
    return <R3>(machine: Machine<State, Event, R3, Effects>) => provideImpl(machine, h);
  }
  // Data-first form: provide(machine, handlers)
  return provideImpl(machineOrHandlers as Machine<State, Event, R, Effects>, handlers);
}

function provideImpl<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Effects extends string,
  R2,
>(
  machine: Machine<State, Event, R, Effects>,
  handlers: EffectHandlers<State, Event, Effects, R2>,
): Machine<State, Event, R | R2, never> {
  // Verify all effect slots have handlers
  for (const [name] of machine.effectSlots) {
    if (!(name in handlers)) {
      throw new Error(`Missing handler for effect slot "${name}"`);
    }
  }

  // Check for extra handlers that don't match any slots
  for (const name of Object.keys(handlers)) {
    if (!machine.effectSlots.has(name)) {
      throw new Error(`Unknown effect slot "${name}" - no slot with this name exists`);
    }
  }

  // Build onEnter and onExit arrays from effect slots + existing effects
  const onEnter: StateEffect<State, Event, R | R2>[] = [...machine.onEnter];
  const onExit: StateEffect<State, Event, R | R2>[] = [...machine.onExit];

  // Process each effect slot and create the appropriate StateEffect
  for (const [name, slot] of machine.effectSlots) {
    const handler = handlers[name as Effects];

    if (slot.type === "invoke") {
      // Invoke creates both an onEnter (to fork the effect) and onExit (to cancel it)
      const invokeKey = Symbol(`invoke:${name}`);

      // Per-actor, per-invoke fiber storage
      const actorInvokeFibers = new WeakMap<
        MachineRef<unknown>,
        Map<symbol, Fiber.RuntimeFiber<void, never>>
      >();

      const getFiberMap = (
        self: MachineRef<Event>,
      ): Map<symbol, Fiber.RuntimeFiber<void, never>> => {
        const key = self as MachineRef<unknown>;
        let map = actorInvokeFibers.get(key);
        if (map === undefined) {
          map = new Map();
          actorInvokeFibers.set(key, map);
        }
        return map;
      };

      const enterEffect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
        handler: (ctx) =>
          Effect.gen(function* () {
            const fiber = yield* Effect.fork(handler(ctx));
            getFiberMap(ctx.self).set(invokeKey, fiber);
          }),
      };

      const exitEffect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
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

      onEnter.push(enterEffect as StateEffect<State, Event, R | R2>);
      onExit.push(exitEffect as StateEffect<State, Event, R | R2>);
    } else if (slot.type === "onEnter") {
      const effect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
        handler,
      };
      onEnter.push(effect as StateEffect<State, Event, R | R2>);
    } else if (slot.type === "onExit") {
      const effect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
        handler,
      };
      onExit.push(effect as StateEffect<State, Event, R | R2>);
    }
  }

  // Create new machine with effects wired in and empty effectSlots
  const result: Machine<State, Event, R | R2, never> = Object.create(PipeableProto);
  return Object.assign(result, {
    initial: machine.initial,
    transitions: machine.transitions as Machine<State, Event, R | R2, never>["transitions"],
    alwaysTransitions: machine.alwaysTransitions as Machine<
      State,
      Event,
      R | R2,
      never
    >["alwaysTransitions"],
    onEnter,
    onExit,
    finalStates: machine.finalStates,
    effectSlots: new Map<string, EffectSlot>(),
  });
}
