// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * EntityMachine adapter - wires a machine to a cluster Entity layer.
 *
 * Uses the runtime kernel for a single serialized event loop per entity.
 * All events (external RPCs + internal self.send) go through the
 * runtime kernel's single queue — no split-mailbox race.
 *
 * v3 uses `entity.toLayer` with handler objects (no `toLayerQueue`/`toLayerMailbox`).
 * Supports opt-in persistence (snapshot or journal strategy).
 *
 * @module
 */
import { Entity } from "@effect/cluster";
import type { Rpc } from "@effect/rpc";
import { type Duration, Effect, type Layer, Option, Ref, type Schedule } from "effect";

import { type Machine, replay } from "../machine.js";
import type { ActorSystem } from "../actor.js";
import { ActorSystem as ActorSystemTag } from "../actor.js";
import type { ProcessEventHooks } from "../internal/transition.js";
import { createRuntime } from "../internal/runtime.js";
import { stubSystem } from "../internal/utils.js";
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
   * Forwarded to Entity.toLayer.
   */
  readonly maxIdleTime?: Duration.DurationInput;

  /**
   * Concurrency for handler execution.
   * Forwarded to Entity.toLayer.
   */
  readonly concurrency?: number | "unbounded";

  /**
   * Mailbox capacity. Default: "unbounded".
   * Forwarded to Entity.toLayer.
   */
  readonly mailboxCapacity?: number | "unbounded";

  /**
   * Disable fatal defects (defects won't crash the entity activation).
   * Forwarded to Entity.toLayer.
   */
  readonly disableFatalDefects?: boolean;

  /**
   * Retry policy for defects (schedule for restarting after defect).
   * Forwarded to Entity.toLayer.
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
 * v3: Uses `Entity.toLayer` with handler objects backed by the runtime kernel.
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
    machine: Machine<S, E, R, any, any, any>,
    options?: EntityMachineOptions<S, E>,
  ): Layer.Layer<never, never, R> => {
    const persistence = options?.persistence;

    // Build function creates the runtime kernel, returns RPC handlers
    const build = Effect.gen(function* () {
      // Get entity ID from context (provided by Entity activation)
      const entityId = yield* Effect.serviceOption(Entity.CurrentAddress).pipe(
        Effect.map((opt) => (opt._tag === "Some" ? opt.value.entityId : "")),
      );

      // Resolve actor system from context, or use stub
      const existingSystem = yield* Effect.serviceOption(ActorSystemTag);
      const system: ActorSystem = Option.isSome(existingSystem) ? existingSystem.value : stubSystem;

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
        childIdPrefix: `${entityId}/`,
      });

      // ----------------------------------------------------------------
      // Persistence: deactivation finalizer (save final snapshot)
      // v3: no SubscriptionRef, no background snapshot scheduler
      // ----------------------------------------------------------------
      if (persistCtx.adapter !== undefined) {
        const { adapter: pAdapter, key } = persistCtx;

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            const state: S = yield* runtime.getState;
            const version = yield* Ref.get(versionRef);
            yield* pAdapter.saveSnapshot(key, {
              state,
              version,
              timestamp: Date.now(),
            } satisfies Snapshot<S>);
          }).pipe(Effect.catchAll(() => Effect.void)),
        );
      }

      // Compute journal context for RPC handlers
      const hasPersistence = persistCtx.adapter !== undefined;
      const journalCtx =
        hasPersistence && (persistence?.strategy ?? "snapshot") === "journal"
          ? { adapter: persistCtx.adapter, key: persistCtx.key }
          : undefined;

      // Return RPC handlers backed by the runtime kernel
      return entity.of({
        Send: (envelope: { payload: { event: E } }) =>
          Effect.gen(function* () {
            yield* runtime.sendWait(envelope.payload.event);
            if (journalCtx !== undefined) {
              yield* persistEvent(
                journalCtx.adapter,
                journalCtx.key,
                versionRef,
                envelope.payload.event,
              );
            } else if (hasPersistence) {
              yield* Ref.update(versionRef, (v) => v + 1);
            }
            return (yield* runtime.getState) as never;
          }),

        Ask: (envelope: { payload: { event: E } }) =>
          Effect.gen(function* () {
            const reply = yield* runtime.ask(envelope.payload.event);
            if (journalCtx !== undefined) {
              yield* persistEvent(
                journalCtx.adapter,
                journalCtx.key,
                versionRef,
                envelope.payload.event,
              );
            } else if (hasPersistence) {
              yield* Ref.update(versionRef, (v) => v + 1);
            }
            return reply as never;
          }),

        GetState: () => runtime.getState as Effect.Effect<never>,
        // Entity.of expects handlers matching Rpcs type param — dynamic construction requires cast
      } as unknown as Parameters<typeof entity.of>[0]);
    });

    // Collect cluster options to forward
    const clusterOptions: {
      maxIdleTime?: Duration.DurationInput;
      concurrency?: number | "unbounded";
      mailboxCapacity?: number | "unbounded";
      disableFatalDefects?: boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      defectRetryPolicy?: Schedule.Schedule<any, unknown>;
    } = {};
    if (options?.maxIdleTime !== undefined) clusterOptions.maxIdleTime = options.maxIdleTime;
    if (options?.concurrency !== undefined) clusterOptions.concurrency = options.concurrency;
    if (options?.mailboxCapacity !== undefined)
      clusterOptions.mailboxCapacity = options.mailboxCapacity;
    if (options?.disableFatalDefects !== undefined)
      clusterOptions.disableFatalDefects = options.disableFatalDefects;
    if (options?.defectRetryPolicy !== undefined)
      clusterOptions.defectRetryPolicy = options.defectRetryPolicy;

    return entity.toLayer(
      // Cast needed: createRuntime error channel is `never` when runtime.ts types are sound,
      // but cascading inference issues may widen it. toLayer requires E=never.
      build.pipe(Effect.orDie) as Effect.Effect<Parameters<typeof entity.of>[0], never, unknown>,
      Object.keys(clusterOptions).length > 0 ? clusterOptions : undefined,
    ) as unknown as Layer.Layer<never, never, R>;
  },
};

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
  machine: Machine<S, E, any, any, any, any>,
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
        const hydratedState = yield* replay(machine, eventValues, { from: baseState });
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

/**
 * Append a single event to the journal, incrementing version.
 *
 * On failure: defects the entity activation. The cluster's defectRetryPolicy
 * restarts the entity from the last consistent snapshot.
 */
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
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Journal append failed, defecting entity", { key, error }),
    ),
    Effect.orDie,
  );
