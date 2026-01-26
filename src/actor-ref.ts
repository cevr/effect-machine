import type { Effect, Stream, SubscriptionRef } from "effect";

/**
 * Reference to a running actor.
 */
export interface ActorRef<State extends { readonly _tag: string }, Event> {
  /**
   * Unique identifier for this actor
   */
  readonly id: string;

  /**
   * Send an event to the actor
   */
  readonly send: (event: Event) => Effect.Effect<void>;

  /**
   * Observable state of the actor
   */
  readonly state: SubscriptionRef.SubscriptionRef<State>;

  /**
   * Stop the actor gracefully
   */
  readonly stop: Effect.Effect<void>;

  /**
   * Get current state snapshot (Effect)
   */
  readonly snapshot: Effect.Effect<State>;

  /**
   * Get current state snapshot (sync)
   */
  readonly snapshotSync: () => State;

  /**
   * Check if current state matches tag (Effect)
   */
  readonly matches: (tag: State["_tag"]) => Effect.Effect<boolean>;

  /**
   * Check if current state matches tag (sync)
   */
  readonly matchesSync: (tag: State["_tag"]) => boolean;

  /**
   * Check if event can be handled in current state (Effect)
   */
  readonly can: (event: Event) => Effect.Effect<boolean>;

  /**
   * Check if event can be handled in current state (sync)
   */
  readonly canSync: (event: Event) => boolean;

  /**
   * Stream of state changes
   */
  readonly changes: Stream.Stream<State>;

  /**
   * Subscribe to state changes (sync callback)
   * Returns unsubscribe function
   */
  readonly subscribe: (fn: (state: State) => void) => () => void;
}
