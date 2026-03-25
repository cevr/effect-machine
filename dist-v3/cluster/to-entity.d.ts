import { Machine } from "../machine.js";
import { Rpc } from "../node_modules/@effect/rpc/dist/dts/Rpc.js";
import { Entity } from "../node_modules/@effect/cluster/dist/dts/Entity.js";
import { Schema } from "effect";

//#region src-v3/cluster/to-entity.d.ts
/**
 * Options for toEntity.
 */
interface ToEntityOptions {
  /**
   * Entity type name (e.g., "Order", "User")
   */
  readonly type: string;
}
/**
 * Default RPC protocol for entity machines.
 *
 * - `Send` - Send event to machine, returns new state
 * - `GetState` - Get current state
 */
type EntityRpcs<
  StateSchema extends Schema.Schema.Any,
  EventSchema extends Schema.Schema.Any,
> = readonly [
  Rpc<
    "Send",
    Schema.Struct<{
      readonly event: EventSchema;
    }>,
    StateSchema,
    typeof Schema.Never,
    never
  >,
  Rpc<"GetState", typeof Schema.Void, StateSchema, typeof Schema.Never, never>,
];
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
declare const toEntity: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
>(
  machine: Machine<S, E, R, any, any, any, any>,
  options: ToEntityOptions,
) => Entity<
  string,
  | Rpc<
      "Send",
      Schema.Struct<{
        event: any;
      }>,
      any,
      Schema.Never,
      never
    >
  | Rpc<"GetState", Schema.Void, any, Schema.Never, never>
>;
//#endregion
export { EntityRpcs, ToEntityOptions, toEntity };
