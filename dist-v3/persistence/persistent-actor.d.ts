import { PersistentMachine } from "./persistent-machine.js";
import { EffectsDef, GuardsDef } from "../slot.js";
import { PersistedEvent, PersistenceError, Snapshot, VersionConflictError } from "./adapter.js";
import { ActorRef } from "../actor.js";
import { Effect, Option } from "effect";

//#region src-v3/persistence/persistent-actor.d.ts
/**
 * Extended ActorRef with persistence capabilities
 */
interface PersistentActorRef<
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R = never,
> extends ActorRef<S, E> {
  /**
   * Force an immediate snapshot save
   */
  readonly persist: Effect.Effect<void, PersistenceError | VersionConflictError>;
  /**
   * Get the current persistence version
   */
  readonly version: Effect.Effect<number>;
  /**
   * Replay events to restore actor to a specific version.
   * Note: This only computes state; does not re-run transition effects.
   */
  readonly replayTo: (version: number) => Effect.Effect<void, PersistenceError, R>;
}
/**
 * Create a persistent actor from a PersistentMachine.
 * Restores from existing snapshot if available, otherwise starts fresh.
 */
declare const createPersistentActor: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
  initialSnapshot: Option.Option<Snapshot<S>>,
  initialEvents: readonly PersistedEvent<E>[],
) => Effect.Effect<PersistentActorRef<S, E, R>, unknown, unknown>;
/**
 * Restore an actor from persistence.
 * Returns None if no persisted state exists.
 */
declare const restorePersistentActor: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
>(
  id: string,
  persistentMachine: PersistentMachine<S, E, R>,
) => Effect.Effect<
  Option.None<PersistentActorRef<S, E, R>> | Option.Some<PersistentActorRef<S, E, R>>,
  unknown,
  unknown
>;
//#endregion
export { PersistentActorRef, createPersistentActor, restorePersistentActor };
