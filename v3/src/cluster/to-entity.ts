/**
 * Generate Entity definition from a machine.
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import { Rpc } from "@effect/rpc";
import type { Schema } from "effect";

import type { Machine } from "../machine.js";
import { MissingSchemaError } from "../errors.js";

/**
 * Options for toEntity.
 */
export interface ToEntityOptions {
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
export type EntityRpcs<
  StateSchema extends Schema.Schema.Any,
  EventSchema extends Schema.Schema.Any,
> = readonly [
  Rpc.Rpc<
    "Send",
    Schema.Struct<{ readonly event: EventSchema }>,
    StateSchema,
    typeof Schema.Never,
    never
  >,
  Rpc.Rpc<"GetState", typeof Schema.Void, StateSchema, typeof Schema.Never, never>,
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
export const toEntity = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, any, any>,
  options: ToEntityOptions,
) => {
  const stateSchema = machine.stateSchema;
  const eventSchema = machine.eventSchema;

  if (stateSchema === undefined || eventSchema === undefined) {
    throw new MissingSchemaError({ operation: "toEntity" });
  }

  return Entity.make(options.type, [
    Rpc.make("Send", {
      payload: { event: eventSchema },
      success: stateSchema,
    }),
    Rpc.make("GetState", {
      success: stateSchema,
    }),
  ]);
};
