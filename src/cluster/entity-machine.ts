// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * Uses Entity.toLayerQueue for a single serialized mailbox per entity.
 * All events (external RPCs + internal self.send) go through the
 * runtime kernel's single queue — no split-mailbox race.
 *
 * Supports opt-in persistence (snapshot or journal strategy) for
 * state survival across entity deactivation/reactivation cycles.
 *
 * @module
 */
import { Entity } from "effect/unstable/cluster";
import type { Envelope } from "effect/unstable/cluster";
import type { Rpc } from "effect/unstable/rpc";
import {
  type Duration,
  Effect,
  type Layer,
  Option,
  Queue,
  Ref,
  type Schedule,
  Stream,
  SubscriptionRef,
} from "effect";

import { BuiltMachine, type Machine, replay } from "../machine.js";
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag, makeSystem } from "../actor.js";
import type { ProcessEventHooks } from "../internal/transition.js";
import { createRuntime } from "../internal/runtime.js";
import type {
  EntityPersistenceConfig,
  PersistenceKey,
  PersistedEvent,
  Snapshot,
} from "./persistence.js";
import { PersistenceAdapter } from "./persistence.js";

/**
 * Options for EntityMachine.layer
 */
export interface EntityMachineOptions<S, E> {
  /**
   * Initialize state from entity ID.
   * Called once when entity is first activated.
   */
  readonly initializeState?: (entityId: string) => S;

  /**
   * Optional hooks for inspection/tracing.
   */
  readonly hooks?: ProcessEventHooks<S, E>;

  /**
   * Maximum idle time before entity deactivation.
   * Forwarded to Entity.toLayerQueue.
   */
  readonly maxIdleTime?: Duration.Input;

  /**
   * Mailbox capacity. Default: "unbounded".
   * Forwarded to Entity.toLayerQueue.
   */
  readonly mailboxCapacity?: number | "unbounded";

  /**
   * Disable fatal defects (defects won't crash the entity activation).
   * Forwarded to Entity.toLayerQueue.
   */
  readonly disableFatalDefects?: boolean;

  /**
   * Retry policy for defects (schedule for restarting after defect).
   * Forwarded to Entity.toLayerQueue.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schedule type needs wide acceptance
  readonly defectRetryPolicy?: Schedule.Schedule<any, unknown>;

  /**
   * Persistence configuration. When set, requires PersistenceAdapter in R.
   */
  readonly persistence?: EntityPersistenceConfig;
}

/**
 * Create an Entity layer that wires a machine to handle RPC calls.
 *
 * Uses `Entity.toLayerQueue` for a single serialized mailbox per entity.
 * The runtime kernel handles event processing, postpone, background effects,
 * spawn effects, and final state detection.
 *
 * @example
 * ```ts
 * const OrderEntity = toEntity(orderMachine, { type: "Order" })
 *
 * const OrderEntityLayer = EntityMachine.layer(OrderEntity, orderMachine, {
 *   initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
 * })
 * ```
 */
export const EntityMachine = {
  layer: <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    EntityType extends string,
    Rpcs extends Rpc.Any,
  >(
    entity: Entity.Entity<EntityType, Rpcs>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Machine type params need wide acceptance
    machine: Machine<S, E, R, any, any, any, any>,
    options?: EntityMachineOptions<S, E>,
  ): Layer.Layer<never, never, R> => {
    const persistence = options?.persistence;

    // Build function receives (queue, replier) from Entity.toLayerQueue
    const build = Effect.gen(function* () {
      // Get entity ID from context (provided by Entity activation)
      const entityId = yield* Effect.serviceOption(Entity.CurrentAddress).pipe(
        Effect.map((opt) => (opt._tag === "Some" ? opt.value.entityId : "")),
      );

      // Resolve actor system from context, or create implicit one
      const existingSystem = yield* Effect.serviceOption(ActorSystemTag);
      const system: ActorSystem = Option.isSome(existingSystem)
        ? existingSystem.value
        : yield* makeSystem();

      // ----------------------------------------------------------------
      // Persistence: hydration
      // ----------------------------------------------------------------
      const persistCtx = yield* hydratePersistence<S, E>(
        persistence,
        entity as { readonly type: string },
        entityId,
        machine,
        options?.initializeState,
      );

      // Compute final initial state: hydrated > initializeState > machine.initial
      const initialState =
        persistCtx.hydratedState ??
        (options?.initializeState !== undefined ? options.initializeState(entityId) : undefined);

      const machineWithState =
        initialState !== undefined
          ? Object.create(machine, {
              initial: { value: initialState, enumerable: true },
            })
          : machine;

      // Version tracking
      const versionRef = yield* Ref.make(persistCtx.initialVersion);

      // Create runtime kernel — single queue, sequential processing
      const runtime = yield* createRuntime(machineWithState, system, {
        actorId: entityId,
        hooks: options?.hooks,
      });

      // ----------------------------------------------------------------
      // Persistence: snapshot scheduler (background, best-effort)
      // ----------------------------------------------------------------
      if (persistCtx.adapter !== undefined) {
        const { adapter: pAdapter, key } = persistCtx;
        const schedule = persistence?.snapshotSchedule;

        // Background snapshot fiber — scoped to entity activation
        yield* SubscriptionRef.changes(runtime.stateRef).pipe(
          schedule !== undefined ? Stream.schedule(schedule) : (s: Stream.Stream<S>) => s,
          Stream.runForEach((state) =>
            Effect.gen(function* () {
              const version = yield* Ref.get(versionRef);
              yield* pAdapter.saveSnapshot(key, {
                state,
                version,
                timestamp: Date.now(),
              } satisfies Snapshot<S>);
            }).pipe(Effect.catch(() => Effect.void)),
          ),
          Effect.forkScoped,
        );

        // Deactivation finalizer — save final snapshot
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.get(runtime.stateRef);
            const version = yield* Ref.get(versionRef);
            yield* pAdapter.saveSnapshot(key, {
              state,
              version,
              timestamp: Date.now(),
            } satisfies Snapshot<S>);
          }).pipe(Effect.catch(() => Effect.void)),
        );
      }

      // Return the queue-draining loop function
      return (mailbox: Queue.Dequeue<Envelope.Request<Rpcs>>, replier: Entity.Replier<Rpcs>) =>
        Effect.gen(function* () {
          const journalCtx =
            persistCtx.adapter !== undefined && (persistence?.strategy ?? "snapshot") === "journal"
              ? { adapter: persistCtx.adapter, key: persistCtx.key }
              : undefined;

          // eslint-disable-next-line no-constant-condition
          while (true) {
            const request = yield* Queue.take(mailbox);
            const tag = (request as { readonly tag: string }).tag;

            switch (tag) {
              case "Send": {
                const event = (request as { readonly payload: { readonly event: E } }).payload
                  .event;
                // sendWait fails on defect — orDie propagates to toLayerQueue infrastructure
                yield* runtime.sendWait(event).pipe(Effect.orDie);

                // Journal append — inline, before replying
                if (journalCtx !== undefined) {
                  yield* persistEvent(journalCtx.adapter, journalCtx.key, versionRef, event);
                }

                const state = yield* runtime.getState;
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  state as any,
                );
                break;
              }
              case "Ask": {
                const event = (request as { readonly payload: { readonly event: E } }).payload
                  .event;
                const reply = yield* runtime.ask(event);

                // Journal append — inline, before replying
                if (journalCtx !== undefined) {
                  yield* persistEvent(journalCtx.adapter, journalCtx.key, versionRef, event);
                }

                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  reply as any,
                );
                break;
              }
              case "GetState": {
                const state = yield* runtime.getState;
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- RPC success type
                  state as any,
                );
                break;
              }
              case "WatchState": {
                // Streaming RPC — respond with SubscriptionRef.changes stream
                yield* replier.succeed(
                  request,
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- streaming RPC success type
                  SubscriptionRef.changes(runtime.stateRef) as any,
                );
                break;
              }
              default:
                break;
            }
          }
        }) as Effect.Effect<never>;
    });

    // Collect cluster options to forward
    const clusterOptions: {
      maxIdleTime?: Duration.Input;
      mailboxCapacity?: number | "unbounded";
      disableFatalDefects?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defectRetryPolicy?: Schedule.Schedule<any, unknown>;
    } = {};
    if (options?.maxIdleTime !== undefined) clusterOptions.maxIdleTime = options.maxIdleTime;
    if (options?.mailboxCapacity !== undefined)
      clusterOptions.mailboxCapacity = options.mailboxCapacity;
    if (options?.disableFatalDefects !== undefined)
      clusterOptions.disableFatalDefects = options.disableFatalDefects;
    if (options?.defectRetryPolicy !== undefined)
      clusterOptions.defectRetryPolicy = options.defectRetryPolicy;

    return entity.toLayerQueue(
      // orDie: persistence failures during activation are defects (entity retry handles them)
      build.pipe(Effect.orDie),
      Object.keys(clusterOptions).length > 0 ? clusterOptions : undefined,
    ) as unknown as Layer.Layer<never, never, R>;
  },
};

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Persistence context
// ============================================================================

interface PersistenceContext<S> {
  readonly adapter: PersistenceAdapter | undefined;
  readonly key: PersistenceKey;
  readonly hydratedState: S | undefined;
  readonly initialVersion: number;
}

const noPersistence: PersistenceContext<never> = {
  adapter: undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- placeholder, never used when adapter is undefined
  key: undefined as any,
  hydratedState: undefined,
  initialVersion: 0,
};

/** Load snapshot/journal and compute hydrated state. */
const hydratePersistence = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  persistence: EntityPersistenceConfig | undefined,
  entityDef: { readonly type: string },
  entityId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Machine type params need wide acceptance
  machine: Machine<S, E, any, any, any, any, any>,
  initializeState?: (entityId: string) => S,
) =>
  Effect.gen(function* () {
    if (persistence === undefined) return noPersistence as PersistenceContext<S>;

    const adapter = yield* PersistenceAdapter;
    const entityType = persistence.machineType ?? entityDef.type;
    const key: PersistenceKey = { entityType, entityId };

    // Load snapshot
    const maybeSnapshot = yield* adapter.loadSnapshot(key) as Effect.Effect<
      Option.Option<Snapshot<S>>
    >;

    const strategy = persistence.strategy ?? "snapshot";

    if (strategy === "journal") {
      const baseState: S = Option.isSome(maybeSnapshot)
        ? maybeSnapshot.value.state
        : initializeState !== undefined
          ? initializeState(entityId)
          : machine.initial;
      const snapshotVersion = Option.isSome(maybeSnapshot) ? maybeSnapshot.value.version : 0;

      const events = (yield* adapter.loadEvents(key, snapshotVersion)) as ReadonlyArray<
        PersistedEvent<E>
      >;

      if (events.length > 0) {
        const eventValues = events.map((e: PersistedEvent<E>) => e.event);
        const built = new BuiltMachine(machine);
        const hydratedState = yield* replay(built, eventValues, { from: baseState });
        const lastEvent = events[events.length - 1];
        const initialVersion = lastEvent !== undefined ? lastEvent.version : snapshotVersion;
        return { adapter, key, hydratedState, initialVersion };
      }

      return {
        adapter,
        key,
        hydratedState: Option.isSome(maybeSnapshot) ? maybeSnapshot.value.state : undefined,
        initialVersion: snapshotVersion,
      };
    }

    // Snapshot strategy
    if (Option.isSome(maybeSnapshot)) {
      return {
        adapter,
        key,
        hydratedState: maybeSnapshot.value.state,
        initialVersion: maybeSnapshot.value.version,
      };
    }

    return { adapter, key, hydratedState: undefined, initialVersion: 0 };
  });

/** Append a single event to the journal, incrementing version. Errors logged, don't crash. */
const persistEvent = <E>(
  adapter: PersistenceAdapter,
  key: PersistenceKey,
  versionRef: Ref.Ref<number>,
  event: E,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const expectedVersion = yield* Ref.get(versionRef);
    const newVersion = expectedVersion + 1;
    const persisted: PersistedEvent<unknown> = {
      event,
      version: newVersion,
      timestamp: Date.now(),
    };
    yield* adapter.appendEvents(key, [persisted], expectedVersion);
    yield* Ref.set(versionRef, newVersion);
  }).pipe(Effect.catch(() => Effect.void));
