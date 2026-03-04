import { MissingSchemaError } from "../errors.js";
import { make } from "../node_modules/@effect/rpc/dist/esm/Rpc.js";
import { make as make$1 } from "../node_modules/@effect/cluster/dist/esm/Entity.js";

//#region src-v3/cluster/to-entity.ts
/**
 * Generate Entity definition from a machine.
 *
 * @module
 */
/**
 * Generate an Entity definition from a machine.
 *
 * Creates an Entity with a standard RPC protocol:
 * - `Send(event)` - Process event through machine, returns new state
 * - `GetState()` - Returns current state
 *
 * Schemas are read from the machine - must use `Machine.make({ state, event, initial })`.
 *
 * @example
 * ```ts
 * const OrderState = State({
 *   Pending: { orderId: Schema.String },
 *   Shipped: { trackingId: Schema.String },
 * })
 *
 * const OrderEvent = Event({
 *   Ship: { trackingId: Schema.String },
 * })
 *
 * const orderMachine = Machine.make({
 *   state: OrderState,
 *   event: OrderEvent,
 *   initial: OrderState.Pending({ orderId: "" }),
 * }).pipe(
 *   Machine.on(OrderState.Pending, OrderEvent.Ship, ...),
 * )
 *
 * const OrderEntity = toEntity(orderMachine, { type: "Order" })
 * ```
 */
const toEntity = (machine, options) => {
  const stateSchema = machine.stateSchema;
  const eventSchema = machine.eventSchema;
  if (stateSchema === void 0 || eventSchema === void 0)
    throw new MissingSchemaError({ operation: "toEntity" });
  return make$1(options.type, [
    make("Send", {
      payload: { event: eventSchema },
      success: stateSchema,
    }),
    make("GetState", { success: stateSchema }),
  ]);
};

//#endregion
export { toEntity };
