import { Schema } from "effect";

//#region src-v3/inspection.d.ts
/**
 * Resolve a type param: if it's a Schema, extract `.Type`; otherwise use as-is.
 */
type ResolveType<T> = T extends Schema.Schema<infer A, infer _I, infer _R> ? A : T;
/**
 * Event emitted when an actor is spawned
 */
interface SpawnEvent<S> {
  readonly type: "@machine.spawn";
  readonly actorId: string;
  readonly initialState: S;
  readonly timestamp: number;
}
/**
 * Event emitted when an actor receives an event
 */
interface EventReceivedEvent<S, E> {
  readonly type: "@machine.event";
  readonly actorId: string;
  readonly state: S;
  readonly event: E;
  readonly timestamp: number;
}
/**
 * Event emitted when a transition occurs
 */
interface TransitionEvent<S, E> {
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
interface EffectEvent<S> {
  readonly type: "@machine.effect";
  readonly actorId: string;
  readonly effectType: "spawn";
  readonly state: S;
  readonly timestamp: number;
}
/**
 * Event emitted when a transition handler or spawn effect fails with a defect
 */
interface ErrorEvent<S, E> {
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
interface StopEvent<S> {
  readonly type: "@machine.stop";
  readonly actorId: string;
  readonly finalState: S;
  readonly timestamp: number;
}
/**
 * Union of all inspection events
 */
type InspectionEvent<S, E> =
  | SpawnEvent<S>
  | EventReceivedEvent<S, E>
  | TransitionEvent<S, E>
  | EffectEvent<S>
  | ErrorEvent<S, E>
  | StopEvent<S>;
/**
 * Convenience alias for untyped inspection events.
 * Useful for general-purpose inspectors that don't need specific state/event types.
 * State and event fields are typed as `{ readonly _tag: string }` so discriminated
 * access to `_tag` works without casting.
 */
type AnyInspectionEvent = InspectionEvent<
  {
    readonly _tag: string;
  },
  {
    readonly _tag: string;
  }
>;
/**
 * Inspector interface for observing machine behavior
 */
interface Inspector<S, E> {
  readonly onInspect: (event: InspectionEvent<S, E>) => void;
}
/**
 * Inspector service tag - optional service for machine introspection
 * Uses `any` types to allow variance flexibility when providing the service
 */
declare const Inspector: any;
/**
 * Create an inspector from a callback function.
 *
 * Type params accept either raw tagged types or Schema constructors:
 * - `makeInspector(cb)` — defaults to `AnyInspectionEvent`
 * - `makeInspector<MyState, MyEvent>(cb)` — explicit tagged types
 * - `makeInspector<typeof MyState, typeof MyEvent>(cb)` — schema constructors (auto-extracts `.Type`)
 */
declare const makeInspector: <
  S = {
    readonly _tag: string;
  },
  E = {
    readonly _tag: string;
  },
>(
  onInspect: (event: InspectionEvent<ResolveType<S>, ResolveType<E>>) => void,
) => Inspector<ResolveType<S>, ResolveType<E>>;
/**
 * Console inspector that logs events in a readable format
 */
declare const consoleInspector: () => Inspector<
  {
    readonly _tag: string;
  },
  {
    readonly _tag: string;
  }
>;
/**
 * Collecting inspector that stores events in an array for testing
 */
declare const collectingInspector: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
>(
  events: InspectionEvent<S, E>[],
) => Inspector<S, E>;
//#endregion
export {
  AnyInspectionEvent,
  EffectEvent,
  ErrorEvent,
  EventReceivedEvent,
  InspectionEvent,
  Inspector,
  SpawnEvent,
  StopEvent,
  TransitionEvent,
  collectingInspector,
  consoleInspector,
  makeInspector,
};
