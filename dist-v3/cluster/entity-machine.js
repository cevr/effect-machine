import { processEventCore, runSpawnEffects } from "../internal/transition.js";
import { ActorSystem } from "../actor.js";
import { CurrentAddress } from "../node_modules/@effect/cluster/dist/esm/Entity.js";
import { Effect, Option, Queue, Ref, Scope } from "effect";
//#region src-v3/cluster/entity-machine.ts
/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * @module
 */
/**
 * Process a single event through the machine using shared core.
 * Returns the new state after processing.
 */
const processEvent = Effect.fn("effect-machine.cluster.processEvent")(
  function* (machine, stateRef, event, self, stateScopeRef, system, hooks) {
    const result = yield* processEventCore(
      machine,
      yield* Ref.get(stateRef),
      event,
      self,
      stateScopeRef,
      system,
      hooks,
    );
    if (result.transitioned) yield* Ref.set(stateRef, result.newState);
    return result.newState;
  },
);
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
const EntityMachine = {
  layer: (entity, machine, options) => {
    const layer = Effect.fn("effect-machine.cluster.layer")(function* () {
      const entityId = yield* Effect.serviceOption(CurrentAddress).pipe(
        Effect.map((opt) => (opt._tag === "Some" ? opt.value.entityId : "")),
      );
      const initialState =
        options?.initializeState !== void 0 ? options.initializeState(entityId) : machine.initial;
      const existingSystem = yield* Effect.serviceOption(ActorSystem);
      if (Option.isNone(existingSystem))
        return yield* Effect.die("EntityMachine requires ActorSystem in context");
      const system = existingSystem.value;
      const internalQueue = yield* Queue.unbounded();
      const self = {
        send: Effect.fn("effect-machine.cluster.self.send")(function* (event) {
          yield* Queue.offer(internalQueue, event);
        }),
        spawn: (childId, childMachine) =>
          system.spawn(childId, childMachine).pipe(Effect.provideService(ActorSystem, system)),
      };
      const stateRef = yield* Ref.make(initialState);
      const stateScopeRef = { current: yield* Scope.make() };
      yield* runSpawnEffects(
        machine,
        initialState,
        { _tag: "$init" },
        self,
        stateScopeRef.current,
        system,
        options?.hooks?.onError,
      );
      const runInternalEvent = Effect.fn("effect-machine.cluster.internalEvent")(function* () {
        yield* processEvent(
          machine,
          stateRef,
          yield* Queue.take(internalQueue),
          self,
          stateScopeRef,
          system,
          options?.hooks,
        );
      });
      yield* Effect.forkScoped(Effect.forever(runInternalEvent()));
      return entity.of({
        Send: (envelope) =>
          processEvent(
            machine,
            stateRef,
            envelope.payload.event,
            self,
            stateScopeRef,
            system,
            options?.hooks,
          ),
        GetState: () => Ref.get(stateRef),
      });
    });
    return entity.toLayer(layer());
  },
};
//#endregion
export { EntityMachine };
