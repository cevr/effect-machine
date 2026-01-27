/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import type { Rpc } from "@effect/rpc";
import { Effect, type Layer, Queue, Ref } from "effect";

import type { Machine, MachineRef, StateEffect } from "../machine.js";
import { findTransitions, findAlwaysTransitions } from "../internal/transition-index.js";

/**
 * Options for EntityMachine.layer
 */
export interface EntityMachineOptions<S> {
  /**
   * Initialize state from entity ID.
   * Called once when entity is first activated.
   *
   * @example
   * ```ts
   * EntityMachine.layer(OrderEntity, orderMachine, {
   *   initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
   * })
   * ```
   */
  readonly initializeState?: (entityId: string) => S;
}

/** Maximum steps for always transitions to prevent infinite loops */
const MAX_ALWAYS_STEPS = 100;

/**
 * Apply always transitions until none match or max steps reached.
 */
const applyAlways = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  state: S,
): Effect.Effect<S, never, R> =>
  Effect.gen(function* () {
    let currentState = state;
    let steps = 0;

    while (steps < MAX_ALWAYS_STEPS) {
      const candidates = findAlwaysTransitions(machine, currentState._tag);
      let found = false;

      for (const transition of candidates) {
        if (transition.guard === undefined || transition.guard(currentState)) {
          const newStateResult = transition.handler(currentState);
          const newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

          if (newState._tag === currentState._tag && newState === currentState) {
            break;
          }

          currentState = newState;
          found = true;
          steps++;
          break;
        }
      }

      if (!found) break;
    }

    return currentState;
  });

/**
 * Run entry effects for a state
 */
const runEntryEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  effects: ReadonlyArray<StateEffect<S, E, R>>,
  state: S,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const stateEffects = effects.filter((e) => e.stateTag === state._tag);
    for (const effect of stateEffects) {
      yield* effect.handler({ state, self });
    }
  });

/**
 * Run exit effects for a state
 */
const runExitEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  effects: ReadonlyArray<StateEffect<S, E, R>>,
  state: S,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const stateEffects = effects.filter((e) => e.stateTag === state._tag);
    for (const effect of stateEffects) {
      yield* effect.handler({ state, self });
    }
  });

/**
 * Process a single event through the machine
 */
const processEvent = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
  stateRef: Ref.Ref<S>,
  event: E,
  self: MachineRef<E>,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const currentState = yield* Ref.get(stateRef);

    // Find matching transition using indexed lookup
    const candidates = findTransitions(machine, currentState._tag, event._tag);

    let transition: (typeof candidates)[number] | undefined;
    for (const t of candidates) {
      if (t.guard === undefined || t.guard({ state: currentState, event })) {
        transition = t;
        break;
      }
    }

    if (transition === undefined) {
      // No valid transition - ignore event
      return;
    }

    // Compute new state
    const newStateResult = transition.handler({ state: currentState, event });
    let newState = Effect.isEffect(newStateResult) ? yield* newStateResult : newStateResult;

    // Run transition effect if any
    if (transition.effect !== undefined) {
      yield* transition.effect({ state: currentState, event });
    }

    // Determine if we should run exit/enter effects
    const stateTagChanged = newState._tag !== currentState._tag;
    const runLifecycle = stateTagChanged || transition.reenter === true;

    if (runLifecycle) {
      // Run exit effects for old state
      yield* runExitEffects(machine.onExit, currentState, self);

      // Apply always transitions (only if tag changed)
      if (stateTagChanged) {
        newState = yield* applyAlways(machine, newState);
      }

      // Update state
      yield* Ref.set(stateRef, newState);

      // Run entry effects for new state
      yield* runEntryEffects(machine.onEnter, newState, self);
    } else {
      // Same state tag without reenter - just update state
      yield* Ref.set(stateRef, newState);
    }
  });

/**
 * Create an Entity layer that wires a machine to handle RPC calls.
 *
 * The layer:
 * - Maintains state via Ref per entity instance
 * - Resolves transitions using the indexed lookup
 * - Evaluates guards in registration order
 * - Runs lifecycle effects (onEnter/onExit)
 * - Processes internal events from invoke effects
 *
 * @example
 * ```ts
 * const OrderEntity = toEntity(orderMachine, {
 *   type: "Order",
 *   stateSchema: OrderState,
 *   eventSchema: OrderEvent,
 * })
 *
 * const OrderEntityLayer = EntityMachine.layer(OrderEntity, orderMachine, {
 *   initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
 * })
 *
 * // Use in cluster
 * const program = Effect.gen(function* () {
 *   const client = yield* ShardingClient.client(OrderEntity)
 *   yield* client.Send("order-123", { event: OrderEvent.Ship({ trackingId: "abc" }) })
 * })
 * ```
 */
export const EntityMachine = {
  /**
   * Create a layer that wires a machine to an Entity.
   *
   * @param entity - Entity created via toEntity()
   * @param machine - Machine with all effects provided (Effects = never)
   * @param options - Optional configuration
   */
  layer: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    EntityType extends string,
    Rpcs extends Rpc.Any,
  >(
    entity: Entity.Entity<EntityType, Rpcs>,
    machine: Machine<S, E, R, never>,
    options?: EntityMachineOptions<S>,
  ): Layer.Layer<never, never, R> => {
    return entity.toLayer(
      Effect.gen(function* () {
        // Get entity ID from context if available
        const entityId = yield* Effect.serviceOption(Entity.CurrentAddress).pipe(
          Effect.map((opt) => (opt._tag === "Some" ? opt.value.entityId : "")),
        );

        // Initialize state - use provided initializer or machine's initial state
        const initialState =
          options?.initializeState !== undefined
            ? options.initializeState(entityId)
            : machine.initial;

        // Apply always transitions to initial state
        const resolvedInitial = yield* applyAlways(machine, initialState);

        // Create state ref
        const stateRef = yield* Ref.make<S>(resolvedInitial);

        // Create internal event queue for invoke effects
        const internalQueue = yield* Queue.unbounded<E>();

        // Self reference for sending events back to machine
        const self: MachineRef<E> = {
          send: (event) => Queue.offer(internalQueue, event),
        };

        // Run initial entry effects
        yield* runEntryEffects(machine.onEnter, resolvedInitial, self);

        // Process internal events in background
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const event = yield* Queue.take(internalQueue);
              yield* processEvent(machine, stateRef, event, self);
            }),
          ),
        );

        // Return handlers matching the Entity's RPC protocol
        // The actual types are inferred from the entity definition
        return entity.of({
          Send: (envelope: { payload: { event: E } }) =>
            Effect.gen(function* () {
              const event = envelope.payload.event;
              yield* processEvent(machine, stateRef, event, self);
              return yield* Ref.get(stateRef);
            }),

          GetState: () => Ref.get(stateRef),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic entity handler typing
        } as any);
      }),
    ) as unknown as Layer.Layer<never, never, R>;
  },
};
