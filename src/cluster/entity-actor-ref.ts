/**
 * EntityActorRef — typed client wrapper for remote entity machines.
 *
 * Provides an ActorRef-like API over the cluster RPC protocol:
 * - send (fire-and-forget, returns new state)
 * - ask (typed domain reply)
 * - snapshot (current state)
 * - watch (streaming state observation)
 * - waitFor (wait for specific state)
 *
 * @module
 */
import type { RpcClient } from "effect/unstable/rpc";
import type { Schema } from "effect";
import { Effect, Option, Stream } from "effect";

import type { ExtractReply, ReplyTypeBrand } from "../internal/brands.js";
import type { NoReplyError } from "../errors.js";
import { ActorStoppedError } from "../errors.js";
import type { EntityRpcs } from "./to-entity.js";

/**
 * Typed client wrapper for remote entity machines.
 *
 * Unlike local `ActorRef`, this communicates over cluster RPCs.
 * Only operations that make sense over the network are exposed.
 *
 * @example
 * ```ts
 * const ref = makeEntityActorRef(client, "order-123")
 * yield* ref.send(OrderEvent.Ship({ trackingId: "abc" }))
 * const state = yield* ref.snapshot
 * yield* ref.waitFor((s) => s._tag === "Shipped")
 * ```
 */
export interface EntityActorRef<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
> {
  readonly entityId: string;

  /** Send event. Returns new state after processing. */
  readonly send: (event: Event) => Effect.Effect<State>;

  /** Send event and get typed domain reply (via Event.reply() schema). */
  readonly ask: <E extends Event & ReplyTypeBrand<unknown>>(
    event: E,
  ) => Effect.Effect<ExtractReply<E>, NoReplyError>;

  /** Get current state. */
  readonly snapshot: Effect.Effect<State>;

  /** Stream of state changes (via WatchState streaming RPC). */
  readonly watch: Stream.Stream<State>;

  /** Wait for a state matching the predicate. Snapshots first, then watches stream. */
  readonly waitFor: (
    predicate: (state: State) => boolean,
  ) => Effect.Effect<State, ActorStoppedError>;
}

/**
 * Create an EntityActorRef from a RPC client.
 *
 * @example
 * ```ts
 * const makeClient = yield* Entity.makeTestClient(entity, entityLayer)
 * const client = yield* makeClient("order-123")
 * const ref = makeEntityActorRef(client, "order-123")
 * yield* ref.send(OrderEvent.Process)
 * ```
 */
export const makeEntityActorRef = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
>(
  client: RpcClient.RpcClient<
    EntityRpcs<Schema.Codec<State, unknown>, Schema.Codec<Event, unknown>>
  >,
  entityId: string,
): EntityActorRef<State, Event> => ({
  entityId,
  send: (event: Event) => client.Send({ event }),
  ask: ((event) => client.Ask({ event })) as EntityActorRef<State, Event>["ask"],
  snapshot: client.GetState(),
  watch: client.WatchState(),
  waitFor: (predicate: (state: State) => boolean) =>
    Effect.gen(function* () {
      // Snapshot first — if current state already matches, return immediately
      const current = yield* client.GetState();
      if (predicate(current)) return current;
      // Fall through to streaming observation
      const result = yield* client
        .WatchState()
        .pipe(Stream.filter(predicate), Stream.take(1), Stream.runHead);
      if (Option.isSome(result)) return result.value;
      return yield* ActorStoppedError.make({ actorId: entityId });
    }),
});
