// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * Uses Entity.toLayerQueue for a single serialized mailbox per entity.
 * All events (external RPCs + internal self.send) go through the
 * runtime kernel's single queue — no split-mailbox race.
 *
 * @module
 */
import { Entity } from "effect/unstable/cluster";
import type { Envelope } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import {
  type Duration,
  Effect,
  type Layer,
  Option,
  Queue,
  type Schedule,
  SubscriptionRef,
} from "effect";

import type { Machine } from "../machine.js";
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag, makeSystem } from "../actor.js";
import type { ProcessEventHooks } from "../internal/transition.js";
import { createRuntime } from "../internal/runtime.js";

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
   * Forwarded to Entity.toLayerQueue.
   */
  readonly maxIdleTime?: Duration.Input;

  /**
   * Mailbox capacity. Default: "unbounded".
   * Forwarded to Entity.toLayerQueue.
   */
  readonly mailboxCapacity?: number | "unbounded";

  /**
   * Disable fatal defects (defects won't crash the entity activation).
   * Forwarded to Entity.toLayerQueue.
   */
  readonly disableFatalDefects?: boolean;

  /**
   * Retry policy for defects (schedule for restarting after defect).
   * Forwarded to Entity.toLayerQueue.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schedule type needs wide acceptance
  readonly defectRetryPolicy?: Schedule.Schedule<any, unknown>;
}

/**
 * Create an Entity layer that wires a machine to handle RPC calls.
 *
 * Uses `Entity.toLayerQueue` for a single serialized mailbox per entity.
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
    // Build function receives (queue, replier) from Entity.toLayerQueue
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

      // Resolve actor system from context, or create implicit one
      // Implicit system scoped to entity activation — children torn down on deactivation
      const existingSystem = yield* Effect.serviceOption(ActorSystemTag);
      const system: ActorSystem = Option.isSome(existingSystem)
        ? existingSystem.value
        : yield* makeSystem();

      // Create runtime kernel — single queue, sequential processing
      const runtime = yield* createRuntime(machineWithState, system, {
        actorId: entityId,
        hooks: options?.hooks,
      });

      // Return the queue-draining loop function
      return (mailbox: Queue.Dequeue<Envelope.Request<Rpcs>>, replier: Entity.Replier<Rpcs>) =>
        Effect.gen(function* () {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const request = yield* Queue.take(mailbox);
            const tag = (request as { readonly tag: string }).tag;

            switch (tag) {
              case "Send": {
                const event = (request as { readonly payload: { readonly event: E } }).payload
                  .event;
                // sendWait fails on defect — orDie propagates to toLayerQueue infrastructure
                yield* runtime.sendWait(event).pipe(Effect.orDie);
                const state = yield* runtime.getState;
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  state as any,
                );
                break;
              }
              case "Ask": {
                const event = (request as { readonly payload: { readonly event: E } }).payload
                  .event;
                const reply = yield* runtime.ask(event);
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  reply as any,
                );
                break;
              }
              case "GetState": {
                const state = yield* runtime.getState;
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  state as any,
                );
                break;
              }
              case "WatchState": {
                // Streaming RPC — respond with SubscriptionRef.changes stream
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- streaming RPC success type
                  SubscriptionRef.changes(runtime.stateRef) as any,
                );
                break;
              }
              default:
                break;
            }
          }
        }) as Effect.Effect<never>;
    });

    // Collect cluster options to forward
    const clusterOptions: {
      maxIdleTime?: Duration.Input;
      mailboxCapacity?: number | "unbounded";
      disableFatalDefects?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defectRetryPolicy?: Schedule.Schedule<any, unknown>;
    } = {};
    if (options?.maxIdleTime !== undefined) clusterOptions.maxIdleTime = options.maxIdleTime;
    if (options?.mailboxCapacity !== undefined)
      clusterOptions.mailboxCapacity = options.mailboxCapacity;
    if (options?.disableFatalDefects !== undefined)
      clusterOptions.disableFatalDefects = options.disableFatalDefects;
    if (options?.defectRetryPolicy !== undefined)
      clusterOptions.defectRetryPolicy = options.defectRetryPolicy;

    return entity.toLayerQueue(
      build,
      Object.keys(clusterOptions).length > 0 ? clusterOptions : undefined,
    ) as unknown as Layer.Layer<never, never, R>;
  },
};
