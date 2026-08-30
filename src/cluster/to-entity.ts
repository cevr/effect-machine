/**
 * Generate Entity definition from a machine.
 *
 * @module
 */
import { Entity } from "effect/unstable/cluster";
import { Rpc } from "effect/unstable/rpc";
import { Schema } from "effect";

import type { Machine } from "../machine.js";
import type { MachineEventSchema, MachineStateSchema } from "../schema.js";

/**
 * Options for toEntity.
 */
export interface ToEntityOptions {
  /**
   * Entity type name (e.g., "Order", "User")
   */
  readonly type: string;
}

const makeEntityProtocol = <StateSchema extends Schema.Top, EventSchema extends Schema.Top>(
  stateSchema: StateSchema,
  eventSchema: EventSchema,
) => [
  Rpc.make("Send", {
    payload: { event: eventSchema },
    success: stateSchema,
  }),
  Rpc.make("Ask", {
    payload: { event: eventSchema },
    success: Schema.Unknown,
  }),
  Rpc.make("GetState", {
    success: stateSchema,
  }),
  Rpc.make("WatchState", {
    success: stateSchema,
    stream: true,
  }),
];

/** RPC protocol owned by `toEntity`. */
export type EntityRpcs<StateSchema extends Schema.Top, EventSchema extends Schema.Top> = ReturnType<
  typeof makeEntityProtocol<StateSchema, EventSchema>
>[number];

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
 * }).on(OrderState.Pending, OrderEvent.Ship, ({ event }) =>
 *   OrderState.Shipped({ trackingId: event.trackingId }),
 * )
 *
 * const OrderEntity = toEntity(orderMachine, { type: "Order" })
 * ```
 */
export const toEntity = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  Input,
  Output,
>(
  machine: Machine<S, E, R, SD, ED, Input, Output>,
  options: ToEntityOptions,
): Entity.Entity<
  string,
  EntityRpcs<
    MachineStateSchema<SD> & { readonly Type: S },
    MachineEventSchema<ED> & { readonly Type: E }
  >
> => {
  const stateSchema = machine.stateSchema;
  const eventSchema = machine.eventSchema;

  return Entity.make(options.type, makeEntityProtocol(stateSchema, eventSchema));
};
