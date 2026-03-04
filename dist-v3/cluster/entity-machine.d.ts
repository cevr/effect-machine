import { EffectsDef, GuardsDef } from "../slot.js";
import { ProcessEventHooks } from "../internal/transition.js";
import { Machine } from "../machine.js";
import "../actor.js";
import { Any } from "../node_modules/@effect/rpc/dist/dts/Rpc.js";
import { Entity } from "../node_modules/@effect/cluster/dist/dts/Entity.js";
import "../node_modules/@effect/cluster/dist/dts/index.js";
import "../node_modules/@effect/rpc/dist/dts/index.js";
import { Layer } from "effect";

//#region src-v3/cluster/entity-machine.d.ts
/**
 * Options for EntityMachine.layer
 */
interface EntityMachineOptions<S, E> {
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
  /**
   * Optional hooks for inspection/tracing.
   * Called at specific points during event processing.
   *
   * @example
   * ```ts
   * EntityMachine.layer(OrderEntity, orderMachine, {
   *   hooks: {
   *     onTransition: (from, to, event) =>
   *       Effect.log(`Transition: ${from._tag} -> ${to._tag}`),
   *     onSpawnEffect: (state) =>
   *       Effect.log(`Running spawn effects for ${state._tag}`),
   *     onError: ({ phase, state }) =>
   *       Effect.log(`Defect in ${phase} at ${state._tag}`),
   *   },
   * })
   * ```
   */
  readonly hooks?: ProcessEventHooks<S, E>;
}
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
declare const EntityMachine: {
  /**
   * Create a layer that wires a machine to an Entity.
   *
   * @param entity - Entity created via toEntity()
   * @param machine - Machine with all effects provided
   * @param options - Optional configuration (state initializer, inspection hooks)
   */
  layer: <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
    GD extends GuardsDef,
    EFD extends EffectsDef,
    EntityType extends string,
    Rpcs extends Any,
  >(
    entity: Entity<EntityType, Rpcs>,
    machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
    options?: EntityMachineOptions<S, E>,
  ) => Layer.Layer<never, never, R>;
};
//#endregion
export { EntityMachine, EntityMachineOptions };
