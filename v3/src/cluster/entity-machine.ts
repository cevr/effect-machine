// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * Uses the runtime kernel for a single serialized event loop per entity.
 * All events (external RPCs + internal self.send) go through the
 * runtime kernel's single queue — no split-mailbox race.
 *
 * v3 uses `entity.toLayer` with handler objects (no `toLayerQueue`/`toLayerMailbox`).
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import type { Rpc } from "@effect/rpc";
import { type Duration, Effect, type Layer, Option, type Schedule } from "effect";

import type { Machine } from "../machine.js";
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag } from "../actor.js";
import type { ProcessEventHooks } from "../internal/transition.js";
import { createRuntime } from "../internal/runtime.js";
import { stubSystem } from "../internal/utils.js";

/**
 * Options for EntityMachine.layer
 */
export interface EntityMachineOptions<S, E> {
  /**
   * Initialize state from entity ID.
   * Called once when entity is first activated.
   */
  readonly initializeState?: (entityId: string) => S;

  /**
   * Optional hooks for inspection/tracing.
   */
  readonly hooks?: ProcessEventHooks<S, E>;

  /**
   * Maximum idle time before entity deactivation.
   * Forwarded to Entity.toLayer.
   */
  readonly maxIdleTime?: Duration.DurationInput;

  /**
   * Concurrency for handler execution.
   * Forwarded to Entity.toLayer.
   */
  readonly concurrency?: number | "unbounded";

  /**
   * Mailbox capacity. Default: "unbounded".
   * Forwarded to Entity.toLayer.
   */
  readonly mailboxCapacity?: number | "unbounded";

  /**
   * Disable fatal defects (defects won't crash the entity activation).
   * Forwarded to Entity.toLayer.
   */
  readonly disableFatalDefects?: boolean;

  /**
   * Retry policy for defects (schedule for restarting after defect).
   * Forwarded to Entity.toLayer.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schedule type needs wide acceptance
  readonly defectRetryPolicy?: Schedule.Schedule<any, unknown>;
}

/**
 * Create an Entity layer that wires a machine to handle RPC calls.
 *
 * Uses `Entity.toLayer` with handler objects backed by the runtime kernel.
 * The runtime kernel handles event processing, postpone, background effects,
 * spawn effects, and final state detection.
 *
 * @example
 * ```ts
 * const OrderEntity = toEntity(orderMachine, { type: "Order" })
 *
 * const OrderEntityLayer = EntityMachine.layer(OrderEntity, orderMachine, {
 *   initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
 * })
 * ```
 */
export const EntityMachine = {
  layer: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    EntityType extends string,
    Rpcs extends Rpc.Any,
  >(
    entity: Entity.Entity<EntityType, Rpcs>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Machine type params need wide acceptance
    machine: Machine<S, E, R, any, any, any, any>,
    options?: EntityMachineOptions<S, E>,
  ): Layer.Layer<never, never, R> => {
    // Build function creates the runtime kernel, returns RPC handlers
    const build = Effect.gen(function* () {
      // Get entity ID from context (provided by Entity activation)
      const entityId = yield* Effect.serviceOption(Entity.CurrentAddress).pipe(
        Effect.map((opt) => (opt._tag === "Some" ? opt.value.entityId : "")),
      );

      // Override machine initial state if initializer provided
      const machineWithState =
        options?.initializeState !== undefined
          ? Object.create(machine, {
              initial: { value: options.initializeState(entityId), enumerable: true },
            })
          : machine;

      // Resolve actor system from context, or use stub
      const existingSystem = yield* Effect.serviceOption(ActorSystemTag);
      const system: ActorSystem = Option.isSome(existingSystem) ? existingSystem.value : stubSystem;

      // Create runtime kernel — single queue, sequential processing
      const runtime = yield* createRuntime(machineWithState, system, {
        actorId: entityId,
        hooks: options?.hooks,
      });

      // Return RPC handlers backed by the runtime kernel
      return entity.of({
        Send: (envelope: { payload: { event: E } }) =>
          Effect.gen(function* () {
            yield* runtime.sendWait(envelope.payload.event);
            return (yield* runtime.getState) as never;
          }),

        Ask: (envelope: { payload: { event: E } }) =>
          runtime.ask(envelope.payload.event) as Effect.Effect<never>,

        GetState: () => runtime.getState as Effect.Effect<never>,
        // Entity.of expects handlers matching Rpcs type param — dynamic construction requires cast
      } as unknown as Parameters<typeof entity.of>[0]);
    });

    // Collect cluster options to forward
    const clusterOptions: {
      maxIdleTime?: Duration.DurationInput;
      concurrency?: number | "unbounded";
      mailboxCapacity?: number | "unbounded";
      disableFatalDefects?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defectRetryPolicy?: Schedule.Schedule<any, unknown>;
    } = {};
    if (options?.maxIdleTime !== undefined) clusterOptions.maxIdleTime = options.maxIdleTime;
    if (options?.concurrency !== undefined) clusterOptions.concurrency = options.concurrency;
    if (options?.mailboxCapacity !== undefined)
      clusterOptions.mailboxCapacity = options.mailboxCapacity;
    if (options?.disableFatalDefects !== undefined)
      clusterOptions.disableFatalDefects = options.disableFatalDefects;
    if (options?.defectRetryPolicy !== undefined)
      clusterOptions.defectRetryPolicy = options.defectRetryPolicy;

    return entity.toLayer(
      // Cast needed: createRuntime error channel is `never` when runtime.ts types are sound,
      // but cascading inference issues may widen it. toLayer requires E=never.
      build as Effect.Effect<Parameters<typeof entity.of>[0], never, unknown>,
      Object.keys(clusterOptions).length > 0 ? clusterOptions : undefined,
    ) as unknown as Layer.Layer<never, never, R>;
  },
};
