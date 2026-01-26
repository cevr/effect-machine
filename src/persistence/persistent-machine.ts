import type { Schema, Schedule } from "effect";

import type { Machine } from "../machine.js";

/**
 * Configuration for persistence behavior.
 * Schemas must have no context requirements (use Schema<S, SI, never>).
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
 * Use after build() to create a PersistentMachine.
 *
 * @example
 * ```ts
 * const orderMachine = pipe(
 *   build(
 *     pipe(
 *       make<State, Event>(State.Idle()),
 *       on(State.Idle, Event.Submit, ({ event }) => State.Pending({ orderId: event.orderId })),
 *       final(State.Paid),
 *     ),
 *   ),
 *   withPersistence({
 *     snapshotSchedule: Schedule.forever,
 *     journalEvents: true,
 *     stateSchema: StateSchema,
 *     eventSchema: EventSchema,
 *   }),
 * );
 * ```
 */
export const withPersistence =
  <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    SSI = unknown,
    ESI = unknown,
  >(
    config: PersistenceConfig<S, E, SSI, ESI>,
  ) =>
  <R>(machine: Machine<S, E, R>): PersistentMachine<S, E, R, SSI, ESI> => ({
    _tag: "PersistentMachine",
    machine,
    persistence: config,
  });
