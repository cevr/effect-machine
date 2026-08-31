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
  Clock,
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

import { type Machine, replay } from "../machine.js";
import type { ActorSystemService, TransitionInfo } from "../actor.js";
import { ActorSystem as ActorSystemTag, makeSystem } from "../actor.js";
import type { InspectorService } from "../inspection.js";
import { Inspector as InspectorTag } from "../inspection.js";
import { ActorInspection, makeInspectionHooks } from "../internal/inspection.js";
import { createRuntime, type RuntimeQueuedEvent } from "../internal/runtime.js";
import {
  PersistenceAdapter,
  type EntityPersistenceConfig,
  type PersistenceAdapterService,
  type PersistenceKey,
  type PersistedEvent,
  type Snapshot,
} from "./persistence.js";

/**
 * Options for EntityMachine.layer
 */
export interface EntityMachineBaseOptions<S> {
  /**
   * Initialize state from entity ID.
   * Called once when entity is first activated.
   */
  readonly initializeState?: (entityId: string) => S;

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
  readonly defectRetryPolicy?: Schedule.Schedule<any>;

  /**
   * Persistence configuration. When set, requires PersistenceAdapterService in R.
   */
  readonly persistence?: EntityPersistenceConfig;
}

export type EntityMachineOptions<S, Input = void> = EntityMachineBaseOptions<S> &
  ([Input] extends [void]
    ? { readonly input?: never }
    : {
        /** Map the entity ID to the machine input. */
        readonly input: (entityId: string) => Input;
      });

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
    Input,
    Output,
    EntityType extends string,
    Rpcs extends Rpc.Any,
  >(
    entity: Entity.Entity<EntityType, Rpcs>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Machine type params need wide acceptance
    machine: Machine<S, E, R, any, any, Input, Output>,
    ...optionsArgument: [Input] extends [void]
      ? [options?: EntityMachineOptions<S, Input>]
      : [options: EntityMachineOptions<S, Input>]
  ): Layer.Layer<never, never, R> => {
    const options = optionsArgument[0];
    const persistence = options?.persistence;

    // Build function receives (queue, replier) from Entity.toLayerQueue
    const build = Effect.gen(function* () {
      // Get entity ID from context (provided by Entity activation)
      const entityId = yield* Effect.serviceOption(Entity.CurrentAddress).pipe(
        Effect.map((opt) => {
          if (opt._tag === "Some") return opt.value.entityId;
          return "";
        }),
      );

      const inspector = Option.getOrUndefined(yield* Effect.serviceOption(InspectorTag)) as
        | InspectorService<S, E>
        | undefined;
      const withActorInspection = <A, E2, R2>(
        effect: Effect.Effect<A, E2, R2>,
      ): Effect.Effect<A, E2, R2> => {
        if (inspector === undefined) return effect;
        return effect.pipe(Effect.provideService(ActorInspection, inspector));
      };

      const machineInitial = machine._initial(options?.input?.(entityId));

      // Resolve actor system from context, or create implicit one
      const existingSystem = yield* Effect.serviceOption(ActorSystemTag);
      let system: ActorSystemService;
      if (Option.isSome(existingSystem)) {
        system = existingSystem.value;
      } else {
        system = yield* makeSystem();
      }

      // ----------------------------------------------------------------
      // Persistence: hydration
      // ----------------------------------------------------------------
      const persistCtx = yield* hydratePersistence<S, E>(
        persistence,
        entity as { readonly type: string },
        entityId,
        machine,
        machineInitial,
        options?.initializeState,
      );

      // Compute final initial state: hydrated > initializeState > machine input.
      let initialState: S | undefined = persistCtx.hydratedState;
      if (initialState === undefined && options?.initializeState !== undefined) {
        initialState = options.initializeState(entityId);
      }

      // Version tracking
      const versionRef = yield* Ref.make(persistCtx.initialVersion);

      // Cell-owned resources — stable identity for this entity activation
      const computedInitial = initialState ?? machineInitial;
      const stateRef = yield* SubscriptionRef.make(computedInitial);
      const latestTransitionRef = yield* SubscriptionRef.make<TransitionInfo<S, E> | undefined>(
        undefined,
      );
      const stoppedRef = yield* Ref.make(false);
      const eventQueue = yield* Queue.unbounded<RuntimeQueuedEvent<S, E>>();
      let hooks: ReturnType<typeof makeInspectionHooks<S, E>> | undefined = undefined;
      if (inspector !== undefined) {
        hooks = makeInspectionHooks(entityId, inspector);
      }

      // Create runtime kernel — single queue, sequential processing
      const runtime = yield* withActorInspection(
        createRuntime(machine, system, {
          actorId: entityId,
          hooks,
          childIdPrefix: `${entityId}/`,
          cellResources: { stateRef, latestTransitionRef, stoppedRef, eventQueue },
        }),
      );
      yield* withActorInspection(runtime.start);

      // ----------------------------------------------------------------
      // Persistence: snapshot scheduling
      // ----------------------------------------------------------------
      if (persistCtx.adapter !== undefined) {
        const { adapter: pAdapter, key } = persistCtx;
        const strategy = persistence?.strategy ?? "snapshot";
        const schedule = persistence?.snapshotSchedule;

        if (strategy === "snapshot") {
          // Snapshot-only mode: background scheduler is safe (no journal to tear against)
          let applySchedule: (s: Stream.Stream<S>) => Stream.Stream<S> = (s) => s;
          if (schedule !== undefined) {
            applySchedule = Stream.schedule(schedule);
          }
          yield* SubscriptionRef.changes(runtime.stateRef).pipe(
            applySchedule,
            Stream.runForEach((state) =>
              Effect.gen(function* () {
                const version = yield* Ref.get(versionRef);
                const now = yield* Clock.currentTimeMillis;
                yield* pAdapter.saveSnapshot(key, {
                  state,
                  version,
                  timestamp: now,
                } satisfies Snapshot<S>);
              }).pipe(Effect.ignore),
            ),
            Effect.forkScoped,
          );
        }
        // Journal mode: no background scheduler — snapshot only on deactivation
        // to avoid state/version tear between concurrent SubscriptionRef and versionRef reads

        // Deactivation finalizer — save final snapshot (safe: runs after event loop stops)
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const state = yield* SubscriptionRef.get(runtime.stateRef);
            const version = yield* Ref.get(versionRef);
            const now = yield* Clock.currentTimeMillis;
            yield* pAdapter.saveSnapshot(key, {
              state,
              version,
              timestamp: now,
            } satisfies Snapshot<S>);
          }).pipe(Effect.ignore),
        );
      }

      // Return the queue-draining loop function
      return (mailbox: Queue.Dequeue<Envelope.Request<Rpcs>>, replier: Entity.Replier<Rpcs>) =>
        Effect.gen(function* () {
          const adapter = persistCtx.adapter;
          const hasPersistence = adapter !== undefined;
          let journalCtx:
            | { adapter: PersistenceAdapterService; key: typeof persistCtx.key }
            | undefined = undefined;
          if (adapter !== undefined && (persistence?.strategy ?? "snapshot") === "journal") {
            journalCtx = { adapter, key: persistCtx.key };
          }

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

                if (journalCtx !== undefined) {
                  // Journal append — inline, before replying. Defects entity on failure.
                  yield* persistEvent(journalCtx.adapter, journalCtx.key, versionRef, event);
                } else if (hasPersistence) {
                  // Snapshot-only: bump version for consistent snapshot versioning
                  yield* Ref.update(versionRef, (v) => v + 1);
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
                // ask fails with NoReplyError on defect — orDie propagates to
                // toLayerQueue infrastructure, matching the sendWait case above.
                const reply = yield* runtime.ask(event).pipe(Effect.orDie);

                if (journalCtx !== undefined) {
                  yield* persistEvent(journalCtx.adapter, journalCtx.key, versionRef, event);
                } else if (hasPersistence) {
                  yield* Ref.update(versionRef, (v) => v + 1);
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
        });
    });

    // Collect cluster options to forward
    const clusterOptions: {
      maxIdleTime?: Duration.Input;
      mailboxCapacity?: number | "unbounded";
      disableFatalDefects?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defectRetryPolicy?: Schedule.Schedule<any>;
    } = {};
    if (options?.maxIdleTime !== undefined) clusterOptions.maxIdleTime = options.maxIdleTime;
    if (options?.mailboxCapacity !== undefined)
      clusterOptions.mailboxCapacity = options.mailboxCapacity;
    if (options?.disableFatalDefects !== undefined)
      clusterOptions.disableFatalDefects = options.disableFatalDefects;
    if (options?.defectRetryPolicy !== undefined)
      clusterOptions.defectRetryPolicy = options.defectRetryPolicy;

    let resolvedClusterOptions: typeof clusterOptions | undefined = undefined;
    if (Object.keys(clusterOptions).length > 0) {
      resolvedClusterOptions = clusterOptions;
    }
    return entity.toLayerQueue(
      // orDie: persistence failures during activation are defects (entity retry handles them)
      build.pipe(Effect.orDie),
      resolvedClusterOptions,
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
  readonly adapter: PersistenceAdapterService | undefined;
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
  machineInitial: S,
  initializeState?: (entityId: string) => S,
) =>
  Effect.gen(function* () {
    if (persistence === undefined) return noPersistence as PersistenceContext<S>;

    const adapter = yield* PersistenceAdapter;
    const entityType = persistence.machineType ?? entityDef.type;
    const key: PersistenceKey = { entityType, entityId };

    // Load snapshot
    // The adapter persists opaque payloads, so snapshots come back as
    // Snapshot<unknown>. Narrowing the decoded value (not the Effect) keeps the
    // error and requirements channels intact.
    const storedSnapshot = yield* adapter.loadSnapshot(key);
    const maybeSnapshot = storedSnapshot as Option.Option<Snapshot<S>>;

    const strategy = persistence.strategy ?? "snapshot";

    if (strategy === "journal") {
      let baseState: S;
      if (Option.isSome(maybeSnapshot)) {
        baseState = maybeSnapshot.value.state;
      } else if (initializeState !== undefined) {
        baseState = initializeState(entityId);
      } else {
        baseState = machineInitial;
      }
      let snapshotVersion = 0;
      if (Option.isSome(maybeSnapshot)) {
        snapshotVersion = maybeSnapshot.value.version;
      }

      const events = (yield* adapter.loadEvents(key, snapshotVersion)) as ReadonlyArray<
        PersistedEvent<E>
      >;

      if (events.length > 0) {
        const eventValues = events.map((e: PersistedEvent<E>) => e.event);
        const hydratedState = yield* replay(machine, eventValues, { from: baseState });
        const lastEvent = events[events.length - 1];
        let initialVersion = snapshotVersion;
        if (lastEvent !== undefined) {
          initialVersion = lastEvent.version;
        }
        return { adapter, key, hydratedState, initialVersion };
      }

      let snapshotState: S | undefined = undefined;
      if (Option.isSome(maybeSnapshot)) {
        snapshotState = maybeSnapshot.value.state;
      }
      return {
        adapter,
        key,
        hydratedState: snapshotState,
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

/**
 * Append a single event to the journal, incrementing version.
 *
 * On failure: defects the entity activation. The cluster's defectRetryPolicy
 * restarts the entity, which rehydrates from the last consistent snapshot +
 * whatever events made it to the journal. This is correct because the in-memory
 * state has already advanced — we can't un-ring that bell — so the activation
 * is now unreliable and must restart.
 */
const persistEvent = <E>(
  adapter: PersistenceAdapterService,
  key: PersistenceKey,
  versionRef: Ref.Ref<number>,
  event: E,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    const expectedVersion = yield* Ref.get(versionRef);
    const newVersion = expectedVersion + 1;
    const now = yield* Clock.currentTimeMillis;
    const persisted: PersistedEvent<unknown> = {
      event,
      version: newVersion,
      timestamp: now,
    };
    yield* adapter.appendEvents(key, [persisted], expectedVersion);
    yield* Ref.set(versionRef, newVersion);
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Journal append failed, defecting entity", { key, error }),
    ),
    Effect.orDie,
  );
