import type { Effect, SubscriptionRef } from "effect";

/**
 * Reference to a running actor.
 */
export interface ActorRef<State, Event> {
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
}
