/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import type { Rpc } from "@effect/rpc";
import { Effect, Exit, type Layer, Queue, Ref, Scope } from "effect";

import type { Machine, MachineRef, HandlerContext } from "../machine.js";
import { resolveTransition, runSpawnEffects } from "../internal/loop.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { isEffect, INTERNAL_ENTER_EVENT } from "../internal/utils.js";

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

/**
 * Process a single event through the machine
 */
const processEvent = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  stateRef: Ref.Ref<S>,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.CloseableScope },
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const currentState = yield* Ref.get(stateRef);

    // Find matching transition
    const transition = resolveTransition(machine, currentState, event);

    if (transition === undefined) {
      // No valid transition - ignore event
      return;
    }

    // Create context for handler
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state: currentState,
      event,
      self,
    };
    const { guards, effects } = machine._createSlotAccessors(ctx);

    const handlerCtx: HandlerContext<S, E, GD, EFD> = {
      state: currentState,
      event,
      guards,
      effects,
    };

    // Compute new state
    const newStateResult = transition.handler(handlerCtx as HandlerContext<S, E, GD, EFD>);
    let newState = isEffect(newStateResult)
      ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
          Effect.provideService(machine.Context, ctx),
        )
      : newStateResult;

    // Determine if we should run lifecycle effects
    const stateTagChanged = newState._tag !== currentState._tag;
    const runLifecycle = stateTagChanged || transition.reenter === true;

    if (runLifecycle) {
      // Close old state scope (interrupts spawn fibers)
      yield* Scope.close(stateScopeRef.current, Exit.void);

      // Update state
      yield* Ref.set(stateRef, newState);

      // Create new state scope
      stateScopeRef.current = yield* Scope.make();

      // Use $enter event for lifecycle effects
      const enterEvent = { _tag: INTERNAL_ENTER_EVENT } as E;

      // Run spawn effects for new state
      yield* runSpawnEffects(machine, newState, enterEvent, self, stateScopeRef.current);
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
 * - Runs lifecycle effects (onEnter/spawn)
 * - Processes internal events from spawn effects
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
   * @param machine - Machine with all effects provided
   * @param options - Optional configuration
   */
  layer: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef,
    EFD extends EffectsDef,
    EntityType extends string,
    Rpcs extends Rpc.Any,
  >(
    entity: Entity.Entity<EntityType, Rpcs>,
    machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
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

        // Create self reference for sending events back to machine
        const internalQueue = yield* Queue.unbounded<E>();
        const self: MachineRef<E> = {
          send: (event) => Queue.offer(internalQueue, event),
        };

        // Create state ref
        const stateRef = yield* Ref.make<S>(initialState);

        // Create state scope for spawn effects
        const stateScopeRef: { current: Scope.CloseableScope } = {
          current: yield* Scope.make(),
        };

        // Use $init event for initial lifecycle
        const initEvent = { _tag: "$init" } as E;

        // Run initial spawn effects
        yield* runSpawnEffects(machine, initialState, initEvent, self, stateScopeRef.current);

        // Process internal events in background
        yield* Effect.forkScoped(
          Effect.forever(
            Effect.gen(function* () {
              const event = yield* Queue.take(internalQueue);
              yield* processEvent(machine, stateRef, event, self, stateScopeRef);
            }),
          ),
        );

        // Return handlers matching the Entity's RPC protocol
        // The actual types are inferred from the entity definition
        return entity.of({
          Send: (envelope: { payload: { event: E } }) =>
            Effect.gen(function* () {
              const event = envelope.payload.event;
              yield* processEvent(machine, stateRef, event, self, stateScopeRef);
              return yield* Ref.get(stateRef);
            }),

          GetState: () => Ref.get(stateRef),
          // Entity.of expects handlers matching Rpcs type param - dynamic construction requires cast
        } as unknown as Parameters<typeof entity.of>[0]);
      }),
    ) as unknown as Layer.Layer<never, never, R>;
  },
};
