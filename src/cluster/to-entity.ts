/**
 * Generate Entity definition from a machine.
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import { Rpc } from "@effect/rpc";
import type { Schema } from "effect";

import type { AnySlot, Machine } from "../machine.js";

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
  Slots extends AnySlot,
>(
  machine: Machine<S, E, R, Slots>,
  options: ToEntityOptions,
) => {
  const stateSchema = machine.stateSchema;
  const eventSchema = machine.eventSchema;

  if (stateSchema === undefined || eventSchema === undefined) {
    throw new Error(
      "toEntity requires schemas attached to the machine. " +
        "Use Machine.make({ state, event, initial }) to create the machine.",
    );
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
