import { Context, Effect, Layer, Option, SynchronizedRef } from "effect";
import type { Scope } from "effect";

import type { ActorRef } from "./actor-ref.js";
import type { Machine } from "./machine.js";
import { createActor } from "./internal/loop.js";

/**
 * Actor system for managing actor lifecycles
 */
export interface ActorSystem {
  /**
   * Spawn a new actor with the given machine
   */
  readonly spawn: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: Machine<S, E, R>,
  ) => Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope>;

  /**
   * Get an existing actor by ID
   */
  readonly get: (id: string) => Effect.Effect<Option.Option<ActorRef<unknown, unknown>>>;

  /**
   * Stop an actor by ID
   */
  readonly stop: (id: string) => Effect.Effect<boolean>;
}

/**
 * ActorSystem service tag
 */
export const ActorSystem = Context.GenericTag<ActorSystem>("@effect/machine/ActorSystem");

/**
 * Internal implementation
 */
const make = Effect.gen(function* () {
  const actors = yield* SynchronizedRef.make(new Map<string, ActorRef<unknown, unknown>>());

  const spawn = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    id: string,
    machine: Machine<S, E, R>,
  ): Effect.Effect<ActorRef<S, E>, never, R | Scope.Scope> =>
    Effect.gen(function* () {
      // Check if actor already exists
      const existing = yield* SynchronizedRef.get(actors);
      if (existing.has(id)) {
        throw new Error(`Actor with id "${id}" already exists`);
      }

      // Create the actor
      const actor = yield* createActor(id, machine);

      // Register it
      yield* SynchronizedRef.update(actors, (map) => {
        const newMap = new Map(map);
        newMap.set(id, actor as ActorRef<unknown, unknown>);
        return newMap;
      });

      // Register cleanup on scope finalization
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* actor.stop;
          yield* SynchronizedRef.update(actors, (map) => {
            const newMap = new Map(map);
            newMap.delete(id);
            return newMap;
          });
        }),
      );

      return actor;
    });

  const get = (id: string): Effect.Effect<Option.Option<ActorRef<unknown, unknown>>> =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(actors);
      const actor = map.get(id);
      return actor !== undefined ? Option.some(actor) : Option.none();
    });

  const stop = (id: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const map = yield* SynchronizedRef.get(actors);
      const actor = map.get(id);
      if (actor === undefined) {
        return false;
      }

      yield* actor.stop;
      yield* SynchronizedRef.update(actors, (m) => {
        const newMap = new Map(m);
        newMap.delete(id);
        return newMap;
      });
      return true;
    });

  return ActorSystem.of({ spawn, get, stop });
});

/**
 * Default ActorSystem layer
 */
export const Default = Layer.effect(ActorSystem, make);
