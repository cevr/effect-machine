/**
 * Generate Entity definition from a machine.
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import { Rpc } from "@effect/rpc";
import type { Schema } from "effect";

import type { Machine } from "../machine.js";

/**
 * Options for toEntity
 */
export interface ToEntityOptions<
  StateSchema extends Schema.Schema.Any,
  EventSchema extends Schema.Schema.Any,
> {
  /**
   * Entity type name (e.g., "Order", "User")
   */
  readonly type: string;

  /**
   * Schema for state serialization.
   * Can be a MachineSchema.State or any Schema.Schema.
   */
  readonly stateSchema: StateSchema;

  /**
   * Schema for event serialization.
   * Can be a MachineSchema.Event or any Schema.Schema.
   */
  readonly eventSchema: EventSchema;
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
 * @example
 * ```ts
 * const OrderState = MachineSchema.State({
 *   Pending: { orderId: Schema.String },
 *   Shipped: { trackingId: Schema.String },
 * })
 *
 * const OrderEvent = MachineSchema.Event({
 *   Ship: { trackingId: Schema.String },
 * })
 *
 * const orderMachine = Machine.make(OrderState.Pending({ orderId: "" })).pipe(
 *   Machine.on(OrderState.Pending, OrderEvent.Ship, ...),
 * )
 *
 * const OrderEntity = toEntity(orderMachine, {
 *   type: "Order",
 *   stateSchema: OrderState,
 *   eventSchema: OrderEvent,
 * })
 *
 * // Use with EntityMachine.layer() to wire the machine
 * ```
 */
export const toEntity = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  Effects extends string,
  StateSchema extends Schema.Schema.Any,
  EventSchema extends Schema.Schema.Any,
>(
  _machine: Machine<S, E, R, Effects>,
  options: ToEntityOptions<StateSchema, EventSchema>,
) => {
  return Entity.make(options.type, [
    Rpc.make("Send", {
      payload: { event: options.eventSchema },
      success: options.stateSchema,
    }),
    Rpc.make("GetState", {
      success: options.stateSchema,
    }),
  ]);
};
