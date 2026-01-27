import type { Schema, Schedule } from "effect";

import type { Machine } from "../machine.js";
import type { StateBrand, EventBrand } from "../internal/brands.js";

// Branded type constraints
type BrandedState = { readonly _tag: string } & StateBrand;
type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Configuration for persistence behavior.
 * Schemas must have no context requirements (use Schema<S, SI, never>).
 *
 * Note: Schema types S and E should match the structural shape of the machine's
 * state and event types (without brands). The schemas don't know about brands.
 */
export interface PersistenceConfig<S, E, SSI = unknown, ESI = unknown> {
  /**
   * Schedule controlling when snapshots are taken.
   * Input is the new state after each transition.
   *
   * Examples:
   * - Schedule.forever — snapshot every transition
   * - Schedule.spaced("5 seconds") — debounced snapshots
   * - Schedule.recurs(100) — every N transitions
   */
  readonly snapshotSchedule: Schedule.Schedule<unknown, S>;

  /**
   * Whether to journal events for replay capability.
   * When true, all events are appended to the event log.
   */
  readonly journalEvents: boolean;

  /**
   * Schema for serializing/deserializing state.
   * Required for type-safe persistence.
   */
  readonly stateSchema: Schema.Schema<S, SSI, never>;

  /**
   * Schema for serializing/deserializing events.
   * Required for type-safe persistence.
   */
  readonly eventSchema: Schema.Schema<E, ESI, never>;

  /**
   * User-provided identifier for the machine type.
   * Used for filtering actors in restoreAll.
   * Optional — defaults to "unknown" if not provided.
   */
  readonly machineType?: string;
}

/**
 * Machine with persistence configuration attached.
 * Spawn auto-detects this and returns PersistentActorRef.
 */
export interface PersistentMachine<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R = never,
  SSI = unknown,
  ESI = unknown,
> {
  readonly _tag: "PersistentMachine";
  readonly machine: Machine<S, E, R>;
  readonly persistence: PersistenceConfig<S, E, SSI, ESI>;
}

/**
 * Type guard to check if a value is a PersistentMachine
 */
export const isPersistentMachine = (
  value: unknown,
): value is PersistentMachine<
  { readonly _tag: string },
  { readonly _tag: string },
  unknown,
  unknown,
  unknown
> =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value as { _tag: unknown })._tag === "PersistentMachine";

/**
 * Attach persistence configuration to a machine.
 *
 * Note: The schema types don't need to include brands - they work with the
 * structural shape of the types. Brands are type-level only.
 *
 * @example
 * ```ts
 * const orderMachine = Machine.make<State, Event>(State.Idle()).pipe(
 *   Machine.on(State.Idle, Event.Submit, ({ event }) => State.Pending({ orderId: event.orderId })),
 *   Machine.final(State.Paid),
 *   Machine.persist({
 *     snapshotSchedule: Schedule.forever,
 *     journalEvents: true,
 *     stateSchema: StateSchema,
 *     eventSchema: EventSchema,
 *   }),
 * );
 * ```
 */
// Type for config to allow flexible schema typing
interface WithPersistenceConfig<SSI, ESI> {
  readonly snapshotSchedule: Schedule.Schedule<unknown, { readonly _tag: string }>;
  readonly journalEvents: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemas operate on unbranded types
  readonly stateSchema: Schema.Schema<any, SSI, never>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schemas operate on unbranded types
  readonly eventSchema: Schema.Schema<any, ESI, never>;
  readonly machineType?: string;
}

export const persist =
  <SSI = unknown, ESI = unknown>(config: WithPersistenceConfig<SSI, ESI>) =>
  <S extends BrandedState, E extends BrandedEvent, R>(
    machine: Machine<S, E, R>,
  ): PersistentMachine<S, E, R, SSI, ESI> => ({
    _tag: "PersistentMachine",
    machine,
    persistence: config as unknown as PersistenceConfig<S, E, SSI, ESI>,
  });
