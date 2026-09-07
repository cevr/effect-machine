import { Deferred, Effect, Exit, Option, Scope, Stream, SubscriptionRef } from "effect";

import type { ActorRef } from "./actor.js";
import * as Machine from "./machine.js";

import { ActorHostClosedError, ActorHostOccupiedError } from "./errors.js";

export { ActorHostClosedError, ActorHostOccupiedError } from "./errors.js";

export interface ActorHost<
  Input,
  S extends { readonly _tag: string },
  E,
  Output,
  Failure,
  HostInput = void,
> {
  /** Register in the current scope. Wait for acquisition; interrupt if this generation closes. */
  readonly host: (
    input: Input,
    hostInput: HostInput,
  ) => Effect.Effect<
    ActorRef<S, E, Output>,
    Failure | ActorHostClosedError | ActorHostOccupiedError,
    Scope.Scope
  >;
  /** Wait for a matching generation. Caller cancellation does not cancel actor startup. */
  readonly acquire: (
    input: Input,
  ) => Effect.Effect<ActorRef<S, E, Output>, Failure | ActorHostClosedError>;
}

/**
 * A lazy actor whose lifetime belongs to its host scope, not its consumers.
 *
 * Call `host` from a machine's state-scoped spawn handler. Call `acquire` from
 * consumers. The first matching consumer supplies the spawn input. Identity
 * values match with Object.is. Host data is a separate factory argument owned by
 * the registered generation; consumers cannot replace it.
 * The factory captures the services at make time;
 * its Scope and ActorScope always belong to the hosting generation. The actor
 * starts before publication, including factories that use Machine.spawn.
 */
export const make = Effect.fn("effect-machine.actorHost.make")(function* <
  Input,
  S extends { readonly _tag: string },
  E,
  Output,
  Failure,
  R,
  HostInput = void,
>(options: {
  readonly identity: (input: Input) => unknown;
  readonly spawn: (
    input: Input,
    hostInput: HostInput,
  ) => Effect.Effect<ActorRef<S, E, Output>, Failure, R>;
}) {
  type Actor = ActorRef<S, E, Output>;
  interface Entry {
    readonly identity: unknown;
    readonly scope: Scope.Closeable;
    readonly requested: Deferred.Deferred<Input>;
    readonly actor: Deferred.Deferred<Actor, Failure | ActorHostClosedError>;
    readonly closed: Deferred.Deferred<void>;
  }
  const services = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const current = yield* SubscriptionRef.make(Option.none<Entry>());
  const closed = yield* Deferred.make<void>();
  const failClosed = Effect.fail(ActorHostClosedError.make({}));
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      yield* Deferred.succeed(closed, undefined);
      const entry = yield* SubscriptionRef.get(current);
      if (Option.isSome(entry)) yield* Scope.close(entry.value.scope, Exit.void);
    }),
  );

  const awaitActor = (entry: Entry): Effect.Effect<Actor, Failure | ActorHostClosedError> =>
    Effect.raceFirst(
      Deferred.await(entry.actor),
      Deferred.await(entry.closed).pipe(Effect.andThen(failClosed)),
    ).pipe(
      Effect.flatMap((actor) =>
        Deferred.isDone(entry.closed).pipe(
          Effect.flatMap((ended) => {
            if (ended) return failClosed;
            return Effect.succeed(actor);
          }),
        ),
      ),
    );

  const host: ActorHost<Input, S, E, Output, Failure, HostInput>["host"] = Effect.fn(
    "effect-machine.actorHost.host",
  )((input, hostInput) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (yield* Deferred.isDone(closed)) return yield* failClosed;
        const generation = yield* Scope.fork(yield* Scope.Scope);
        const entry: Entry = {
          identity: options.identity(input),
          scope: generation,
          requested: yield* Deferred.make<Input>(),
          actor: yield* Deferred.make<Actor, Failure | ActorHostClosedError>(),
          closed: yield* Deferred.make<void>(),
        };
        yield* Scope.addFinalizer(
          generation,
          SubscriptionRef.update(current, (value) => {
            if (Option.isSome(value) && value.value === entry) return Option.none();
            return value;
          }),
        );
        const scope = yield* Scope.fork(generation);
        // Publish closure before startup cancellation; retire the entry after actor cleanup.
        yield* Scope.addFinalizer(
          generation,
          Deferred.succeed(entry.closed, undefined).pipe(
            Effect.andThen(Deferred.fail(entry.actor, ActorHostClosedError.make({}))),
          ),
        );
        const registered = yield* SubscriptionRef.modify(current, (value) => {
          if (
            Option.isSome(value) ||
            Deferred.isDoneUnsafe(closed) ||
            Deferred.isDoneUnsafe(entry.closed)
          ) {
            return [false, value];
          }
          return [true, Option.some(entry)];
        });
        if (!registered) {
          const ended = (yield* Deferred.isDone(closed)) || (yield* Deferred.isDone(entry.closed));
          yield* Scope.close(generation, Exit.void);
          if (ended) return yield* failClosed;
          return yield* ActorHostOccupiedError.make({});
        }
        yield* Effect.forkIn(
          Deferred.complete(
            entry.actor,
            Deferred.await(entry.requested).pipe(
              Effect.flatMap((requested) =>
                Machine.scoped(
                  options.spawn(requested, hostInput).pipe(Effect.tap((actor) => actor.start)),
                ),
              ),
              Scope.provide(scope),
              Effect.provideContext(services),
            ),
          ),
          scope,
        );
        return yield* restore(
          awaitActor(entry).pipe(
            Effect.catchTag("ActorHostClosedError", (error) =>
              Deferred.isDone(entry.closed).pipe(
                Effect.flatMap((ownGenerationClosed) => {
                  if (ownGenerationClosed) return Effect.interrupt;
                  return Effect.fail(error);
                }),
              ),
            ),
          ),
        );
      }),
    ),
  );
  const acquire: ActorHost<Input, S, E, Output, Failure, HostInput>["acquire"] = Effect.fn(
    "effect-machine.actorHost.acquire",
  )((input) =>
    Effect.raceFirst(
      Effect.gen(function* () {
        const identity = options.identity(input);
        const entry = yield* SubscriptionRef.changes(current).pipe(
          Stream.filter(Option.isSome),
          Stream.map((value) => value.value),
          Stream.filter((value) => Object.is(value.identity, identity)),
          Stream.runHead,
          Effect.flatMap(Option.match({ onNone: () => failClosed, onSome: Effect.succeed })),
        );
        yield* Deferred.succeed(entry.requested, input);
        return yield* awaitActor(entry);
      }),
      Deferred.await(closed).pipe(Effect.andThen(failClosed)),
    ),
  );
  return { host, acquire } satisfies ActorHost<Input, S, E, Output, Failure, HostInput>;
});
