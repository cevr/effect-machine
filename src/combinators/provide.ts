import { Effect, Fiber } from "effect";

import type {
  AnySlot,
  EffectSlot,
  GuardHandler,
  Machine,
  RootInvoke,
  StateEffect,
} from "../machine.js";
import type { StateEffectContext, TransitionContext } from "../internal/types.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";
import { pipeArguments } from "effect/Pipeable";
import { createFiberStorage } from "../internal/fiber-storage.js";

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;
type NormalizeR<T> = IsAny<T> extends true ? T : IsUnknown<T> extends true ? never : T;

/**
 * Effect handler function - receives context and returns an effect
 */
export type EffectHandler<State, Event, R> = (
  ctx: StateEffectContext<State, Event>,
) => Effect.Effect<void, never, R>;

/**
 * Guard effect handler - receives transition context and returns Effect<boolean>
 */
export type GuardEffectHandler<State, Event, R> = (
  ctx: TransitionContext<State, Event>,
) => Effect.Effect<boolean, never, R>;

/**
 * Compute handler type based on slot type.
 * Guards return Effect<boolean>, all others return Effect<void>.
 */
export type HandlerForSlot<State, Event, Slot extends AnySlot, R> = Slot extends {
  type: "guard";
}
  ? GuardEffectHandler<State, Event, R>
  : EffectHandler<State, Event, R>;

/**
 * Type for the handlers record - maps slot names to correctly-typed handlers.
 * Guards receive TransitionContext and return Effect<boolean>,
 * other handlers receive StateEffectContext and return Effect<void>.
 */
export type EffectHandlers<State, Event, Slots extends AnySlot, R> = {
  [K in Slots["name"]]: HandlerForSlot<State, Event, Extract<Slots, { name: K }>, R>;
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
 * Handler types are enforced based on slot type:
 * - `invoke`, `onEnter`, `onExit` → `(ctx: StateEffectContext) => Effect<void>`
 * - `guard` → `(ctx: TransitionContext) => Effect<boolean>`
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   Machine.invoke(State.Loading, "fetchData"),
 *   Machine.guard(State.Ready, Event.Print, "canPrint"),
 *   Machine.provide({
 *     // Effect<void> - receives StateEffectContext
 *     fetchData: ({ state, self }) =>
 *       Effect.gen(function* () {
 *         const data = yield* fetchFromApi(state.url)
 *         yield* self.send(Event.Resolve({ data }))
 *       }),
 *     // Effect<boolean> - receives TransitionContext
 *     canPrint: ({ state, event }) =>
 *       Effect.gen(function* () {
 *         const auth = yield* AuthService
 *         return yield* auth.checkPermission(state.userId, "print")
 *       }),
 *   }),
 * )
 * ```
 */
export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  Slots extends AnySlot,
  R2,
>(
  handlers: EffectHandlers<State, Event, Slots, R2>,
): <R>(
  machine: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R | NormalizeR<R2>, never>;

export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Slots extends AnySlot,
  R2,
>(
  machine: Machine<State, Event, R, Slots>,
  handlers: EffectHandlers<State, Event, Slots, R2>,
): Machine<State, Event, R | NormalizeR<R2>, never>;

export function provide<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Slots extends AnySlot,
  R2,
>(
  machineOrHandlers: Machine<State, Event, R, Slots> | EffectHandlers<State, Event, Slots, R2>,
  handlers?: EffectHandlers<State, Event, Slots, R2>,
):
  | Machine<State, Event, R | NormalizeR<R2>, never>
  | (<R3>(
      machine: Machine<State, Event, R3, Slots>,
    ) => Machine<State, Event, R3 | NormalizeR<R2>, never>) {
  // Data-last (curried) form: provide(handlers)
  if (handlers === undefined) {
    const h = machineOrHandlers as EffectHandlers<State, Event, Slots, R2>;
    return <R3>(machine: Machine<State, Event, R3, Slots>) => provideImpl(machine, h);
  }
  // Data-first form: provide(machine, handlers)
  return provideImpl(machineOrHandlers as Machine<State, Event, R, Slots>, handlers);
}

function provideImpl<
  State extends BrandedState,
  Event extends BrandedEvent,
  R,
  Slots extends AnySlot,
  R2,
>(
  machine: Machine<State, Event, R, Slots>,
  handlers: EffectHandlers<State, Event, Slots, R2>,
): Machine<State, Event, R | NormalizeR<R2>, never> {
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

  // Build arrays/maps from effect slots + existing effects
  const onEnter: StateEffect<State, Event, R | R2>[] = [...machine.onEnter];
  const onExit: StateEffect<State, Event, R | R2>[] = [...machine.onExit];
  const rootInvokes: RootInvoke<State, Event, R | R2>[] = [...machine.rootInvokes];
  const guardHandlers = new Map<string, GuardHandler<State, Event, R | R2>>(
    machine.guardHandlers as Map<string, GuardHandler<State, Event, R | R2>>,
  );

  // Process each effect slot
  for (const [name, slot] of machine.effectSlots) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (handlers as Record<string, any>)[name];

    if (slot.type === "guard") {
      // Guard slot → store in guardHandlers map for runtime lookup
      guardHandlers.set(name, handler as GuardHandler<State, Event, R | R2>);
    } else if (slot.type === "invoke") {
      const effectHandler = handler as EffectHandler<State, Event, R2>;
      if (slot.stateTag === null) {
        // Root-level invoke - runs for entire machine lifetime
        const rootInvoke: RootInvoke<State, Event, R2> = {
          name,
          handler: effectHandler,
        };
        rootInvokes.push(rootInvoke as RootInvoke<State, Event, R | R2>);
      } else {
        // State-scoped invoke - creates onEnter (fork) and onExit (cancel)
        const invokeKey = Symbol(`invoke:${name}`);
        const getFiberMap = createFiberStorage();

        const enterEffect: StateEffect<State, Event, R2> = {
          stateTag: slot.stateTag,
          handler: (ctx) =>
            Effect.gen(function* () {
              const fiber = yield* Effect.fork(effectHandler(ctx));
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
      }
    } else if (slot.type === "onEnter") {
      const effect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
        handler: handler as EffectHandler<State, Event, R2>,
      };
      onEnter.push(effect as StateEffect<State, Event, R | R2>);
    } else if (slot.type === "onExit") {
      const effect: StateEffect<State, Event, R2> = {
        stateTag: slot.stateTag,
        handler: handler as EffectHandler<State, Event, R2>,
      };
      onExit.push(effect as StateEffect<State, Event, R | R2>);
    }
  }

  // Create new machine with effects wired in and empty effectSlots
  const result: Machine<State, Event, R | NormalizeR<R2>, never> = Object.create(PipeableProto);
  return Object.assign(result, {
    initial: machine.initial,
    transitions: machine.transitions as Machine<
      State,
      Event,
      R | NormalizeR<R2>,
      never
    >["transitions"],
    alwaysTransitions: machine.alwaysTransitions as Machine<
      State,
      Event,
      R | NormalizeR<R2>,
      never
    >["alwaysTransitions"],
    onEnter,
    onExit,
    rootInvokes,
    guardHandlers,
    finalStates: machine.finalStates,
    effectSlots: new Map<string, EffectSlot>(),
    stateSchema: machine.stateSchema,
    eventSchema: machine.eventSchema,
  });
}
