/**
 * EntityActorRef — typed client wrapper for remote entity machines.
 *
 * Provides an ActorRef-like API over the cluster RPC protocol:
 * - send (fire-and-forget)
 * - ask (typed domain reply)
 * - snapshot (current state)
 *
 * @module
 */
import type { RpcClient } from "effect/unstable/rpc";
import type { Effect } from "effect";

import type { ExtractReply, ReplyTypeBrand } from "../internal/brands.js";
import type { NoReplyError } from "../errors.js";

/**
 * Typed client wrapper for remote entity machines.
 *
 * Unlike local `ActorRef`, this communicates over cluster RPCs.
 * Only operations that make sense over the network are exposed.
 *
 * @example
 * ```ts
 * const ref = yield* EntityActorRef.make(OrderEntity, OrderEntityLayer, "order-123")
 * yield* ref.send(OrderEvent.Ship({ trackingId: "abc" }))
 * const state = yield* ref.snapshot
 * ```
 */
export interface EntityActorRef<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
> {
  readonly entityId: string;

  /** Send event (fire-and-forget). Returns new state after processing. */
  readonly send: (event: Event) => Effect.Effect<State>;

  /** Send event and get typed domain reply (via Event.reply() schema). */
  readonly ask: <E extends Event & ReplyTypeBrand<unknown>>(
    event: E,
  ) => Effect.Effect<ExtractReply<E>, NoReplyError>;

  /** Get current state. */
  readonly snapshot: Effect.Effect<State>;
}

/**
 * Create an EntityActorRef from a test client factory and entity ID.
 *
 * @example
 * ```ts
 * const makeClient = yield* Entity.makeTestClient(entity, entityLayer)
 * const ref = yield* makeEntityActorRef(makeClient, "order-123")
 * yield* ref.send(OrderEvent.Process)
 * ```
 */
export const makeEntityActorRef = <
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC client type varies between v3/v4
  client: RpcClient.RpcClient<any>,
  entityId: string,
): EntityActorRef<State, Event> => ({
  entityId,
  send: (event: Event) =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC client has dynamic shape
    (client as any).Send({ event }) as Effect.Effect<State>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC client has dynamic shape
  ask: ((event: any) => (client as any).Ask({ event })) as any,
  snapshot:
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC client has dynamic shape
    (client as any).GetState() as Effect.Effect<State>,
});
