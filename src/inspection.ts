import { Context } from "effect";

// ============================================================================
// Inspection Events
// ============================================================================

/**
 * Event emitted when an actor is spawned
 */
export interface SpawnEvent<S> {
  readonly type: "@machine.spawn";
  readonly actorId: string;
  readonly initialState: S;
  readonly timestamp: number;
}

/**
 * Event emitted when an actor receives an event
 */
export interface EventReceivedEvent<S, E> {
  readonly type: "@machine.event";
  readonly actorId: string;
  readonly state: S;
  readonly event: E;
  readonly timestamp: number;
}

/**
 * Event emitted when a transition occurs
 */
export interface TransitionEvent<S, E> {
  readonly type: "@machine.transition";
  readonly actorId: string;
  readonly fromState: S;
  readonly toState: S;
  readonly event: E;
  readonly timestamp: number;
}

/**
 * Event emitted when a spawn effect runs
 */
export interface EffectEvent<S> {
  readonly type: "@machine.effect";
  readonly actorId: string;
  readonly effectType: "spawn";
  readonly state: S;
  readonly timestamp: number;
}

/**
 * Event emitted when a transition handler or spawn effect fails with a defect
 */
export interface ErrorEvent<S, E> {
  readonly type: "@machine.error";
  readonly actorId: string;
  readonly phase: "transition" | "spawn";
  readonly state: S;
  readonly event: E;
  readonly error: string;
  readonly timestamp: number;
}

/**
 * Event emitted when an actor stops
 */
export interface StopEvent<S> {
  readonly type: "@machine.stop";
  readonly actorId: string;
  readonly finalState: S;
  readonly timestamp: number;
}

/**
 * Union of all inspection events
 */
export type InspectionEvent<S, E> =
  | SpawnEvent<S>
  | EventReceivedEvent<S, E>
  | TransitionEvent<S, E>
  | EffectEvent<S>
  | ErrorEvent<S, E>
  | StopEvent<S>;

// ============================================================================
// Inspector Service
// ============================================================================

/**
 * Inspector interface for observing machine behavior
 */
export interface Inspector<S, E> {
  readonly onInspect: (event: InspectionEvent<S, E>) => void;
}

/**
 * Inspector service tag - optional service for machine introspection
 * Uses `any` types to allow variance flexibility when providing the service
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Inspector = Context.GenericTag<Inspector<any, any>>("@effect/machine/Inspector");

/**
 * Create an inspector from a callback function
 */
export const makeInspector = <S, E>(
  onInspect: (event: InspectionEvent<S, E>) => void,
): Inspector<S, E> => ({ onInspect });

// ============================================================================
// Built-in Inspectors
// ============================================================================

/**
 * Console inspector that logs events in a readable format
 */
export const consoleInspector = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(): Inspector<S, E> =>
  makeInspector((event) => {
    const prefix = `[${event.actorId}]`;
    switch (event.type) {
      case "@machine.spawn":
        console.log(prefix, "spawned →", event.initialState._tag);
        break;
      case "@machine.event":
        console.log(prefix, "received", event.event._tag, "in", event.state._tag);
        break;
      case "@machine.transition":
        console.log(prefix, event.fromState._tag, "→", event.toState._tag);
        break;
      case "@machine.effect":
        console.log(prefix, event.effectType, "effect in", event.state._tag);
        break;
      case "@machine.error":
        console.log(prefix, "error in", event.phase, event.state._tag, "-", event.error);
        break;
      case "@machine.stop":
        console.log(prefix, "stopped in", event.finalState._tag);
        break;
    }
  });

/**
 * Collecting inspector that stores events in an array for testing
 */
export const collectingInspector = <S, E>(events: InspectionEvent<S, E>[]): Inspector<S, E> =>
  makeInspector((event) => events.push(event));
