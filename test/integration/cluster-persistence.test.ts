// @effect-diagnostics strictEffectProvide:off
// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics missingEffectError:off
// @effect-diagnostics anyUnknownInErrorContext:off
/**
 * Entity Persistence Integration Tests
 *
 * Tests snapshot and journal persistence for entity-machine state
 * across deactivation/reactivation cycles.
 */
import { Entity, ShardingConfig } from "effect/unstable/cluster";
import { Effect, Layer, Ref, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Machine, State, Event, ActorSystemDefault } from "../../src/index.js";
import {
  toEntity,
  EntityMachine,
  makeInMemoryPersistenceAdapter,
} from "../../src/cluster/index.js";

// =============================================================================
// Test machine: simple counter with same-tag transitions
// =============================================================================

const CounterState = State({
  Active: { count: Schema.Number },
  Done: {},
});
type CounterState = typeof CounterState.Type;

const CounterEvent = Event({
  Increment: {},
  Decrement: {},
  Finish: {},
});
type CounterEvent = typeof CounterEvent.Type;

const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Active({ count: 0 }),
})
  .on(CounterState.Active, CounterEvent.Increment, ({ state }) =>
    CounterState.Active({ count: state.count + 1 }),
  )
  .on(CounterState.Active, CounterEvent.Decrement, ({ state }) =>
    CounterState.Active({ count: state.count - 1 }),
  )
  .on(CounterState.Active, CounterEvent.Finish, () => CounterState.Done)
  .final(CounterState.Done);

// =============================================================================
// Helpers
// =============================================================================

const TestShardingConfig = ShardingConfig.layer({
  shardsPerGroup: 300,
  entityMailboxCapacity: 10,
  entityTerminationTimeout: 0,
  entityMessagePollInterval: 5000,
  sendRetryInterval: 100,
});

/**
 * Run a persistence test:
 * 1. Creates shared in-memory adapter
 * 2. Runs first activation (act1), then closes its scope (deactivation)
 * 3. Runs second activation (act2) using same adapter
 */
const runPersistenceTest = <A>(opts: {
  entityType: string;
  strategy: "snapshot" | "journal";
  act1: (client: {
    Send: (payload: { event: CounterEvent }) => Effect.Effect<CounterState>;
  }) => Effect.Effect<void>;
  act2: (client: {
    Send: (payload: { event: CounterEvent }) => Effect.Effect<CounterState>;
    GetState: () => Effect.Effect<CounterState>;
  }) => Effect.Effect<A>;
}): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

      const entity = toEntity(counterMachine, { type: opts.entityType });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
        initializeState: () => CounterState.Active({ count: 0 }),
        persistence: { strategy: opts.strategy },
      });

      const provideLayer = entityLayer.pipe(
        Layer.provide(ActorSystemDefault),
        Layer.provide(adapterLayer),
      );

      // First activation — scoped so deactivation runs on scope close
      yield* Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* Entity.makeTestClient(entity, provideLayer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const client = yield* makeClient("entity-1") as any;
          yield* opts.act1(client);
        }),
      ).pipe(Effect.provide(TestShardingConfig));

      // Second activation — same adapter, new scope
      yield* Effect.scoped(
        Effect.gen(function* () {
          const makeClient = yield* Entity.makeTestClient(entity, provideLayer);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const client = yield* makeClient("entity-1") as any;
          yield* opts.act2(client);
        }),
      ).pipe(Effect.provide(TestShardingConfig));
    }) as Effect.Effect<void>,
  );

// =============================================================================
// Tests
// =============================================================================

describe("Entity Persistence", () => {
  // ---------------------------------------------------------------------------
  // 1. Snapshot strategy — state survives deactivation
  // ---------------------------------------------------------------------------
  test("snapshot: state survives deactivation/reactivation", async () => {
    await runPersistenceTest({
      entityType: "SnapshotSurvive",
      strategy: "snapshot",
      act1: (client) =>
        Effect.gen(function* () {
          yield* client.Send({ event: CounterEvent.Increment });
          yield* client.Send({ event: CounterEvent.Increment });
          yield* client.Send({ event: CounterEvent.Increment });
          // State is Active({ count: 3 })
        }),
      act2: (client) =>
        Effect.gen(function* () {
          const state = yield* client.GetState();
          expect(state._tag).toBe("Active");
          expect((state as { count: number }).count).toBe(3);
        }),
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Journal strategy — replay produces correct state
  // ---------------------------------------------------------------------------
  test("journal: replay produces correct state after reactivation", async () => {
    await runPersistenceTest({
      entityType: "JournalReplay",
      strategy: "journal",
      act1: (client) =>
        Effect.gen(function* () {
          yield* client.Send({ event: CounterEvent.Increment });
          yield* client.Send({ event: CounterEvent.Increment });
          yield* client.Send({ event: CounterEvent.Decrement });
          // State is Active({ count: 1 })
        }),
      act2: (client) =>
        Effect.gen(function* () {
          const state = yield* client.GetState();
          expect(state._tag).toBe("Active");
          expect((state as { count: number }).count).toBe(1);
        }),
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Fresh activation — no stored state
  // ---------------------------------------------------------------------------
  test("fresh activation uses initializeState when no stored data", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

        const entity = toEntity(counterMachine, { type: "Fresh" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
          initializeState: () => CounterState.Active({ count: 42 }),
          persistence: { strategy: "snapshot" },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(
              entity,
              entityLayer.pipe(Layer.provide(ActorSystemDefault), Layer.provide(adapterLayer)),
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("fresh-1")) as any;
            const state = yield* client.GetState();
            expect(state._tag).toBe("Active");
            expect((state as { count: number }).count).toBe(42);
          }),
        ).pipe(Effect.provide(TestShardingConfig));
      }) as Effect.Effect<void>,
    );
  });

  // ---------------------------------------------------------------------------
  // 4. Same-tag transitions are journaled
  // ---------------------------------------------------------------------------
  test("journal: same-tag transitions are captured (not skipped)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { storeRef, layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

        const entity = toEntity(counterMachine, { type: "SameTag" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
          initializeState: () => CounterState.Active({ count: 0 }),
          persistence: { strategy: "journal" },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(
              entity,
              entityLayer.pipe(Layer.provide(ActorSystemDefault), Layer.provide(adapterLayer)),
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("same-tag-1")) as any;

            // 3 same-tag transitions (Active → Active)
            yield* client.Send({ event: CounterEvent.Increment });
            yield* client.Send({ event: CounterEvent.Increment });
            yield* client.Send({ event: CounterEvent.Increment });
          }),
        ).pipe(Effect.provide(TestShardingConfig));

        // Check that all 3 events were journaled
        const store = yield* Ref.get(storeRef);
        const entry = store.get("SameTag/same-tag-1");
        expect(entry).toBeDefined();
        expect(entry?.events.length).toBe(3);
      }) as Effect.Effect<void>,
    );
  });

  // ---------------------------------------------------------------------------
  // 5. Deactivation saves snapshot
  // ---------------------------------------------------------------------------
  test("deactivation saves final snapshot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { storeRef, layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

        const entity = toEntity(counterMachine, { type: "DeactivSnap" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
          initializeState: () => CounterState.Active({ count: 0 }),
          persistence: { strategy: "snapshot" },
        });

        // Activate, transition, then deactivate (scope close)
        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(
              entity,
              entityLayer.pipe(Layer.provide(ActorSystemDefault), Layer.provide(adapterLayer)),
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("snap-1")) as any;
            yield* client.Send({ event: CounterEvent.Increment });
            yield* client.Send({ event: CounterEvent.Increment });
          }),
        ).pipe(Effect.provide(TestShardingConfig));

        // Check adapter has snapshot
        const store = yield* Ref.get(storeRef);
        const entry = store.get("DeactivSnap/snap-1");
        expect(entry).toBeDefined();
        expect(entry?.snapshot).toBeDefined();
        const snapshotState = entry?.snapshot?.state as { count: number } | undefined;
        expect(snapshotState?.count).toBe(2);
      }) as Effect.Effect<void>,
    );
  });

  // ---------------------------------------------------------------------------
  // 6. Version tracking
  // ---------------------------------------------------------------------------
  test("journal: version increments on each transition", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { storeRef, layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

        const entity = toEntity(counterMachine, { type: "VersionTrack" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
          initializeState: () => CounterState.Active({ count: 0 }),
          persistence: { strategy: "journal" },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(
              entity,
              entityLayer.pipe(Layer.provide(ActorSystemDefault), Layer.provide(adapterLayer)),
            );
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("ver-1")) as any;
            yield* client.Send({ event: CounterEvent.Increment });
            yield* client.Send({ event: CounterEvent.Increment });
            yield* client.Send({ event: CounterEvent.Increment });
          }),
        ).pipe(Effect.provide(TestShardingConfig));

        const store = yield* Ref.get(storeRef);
        const entry = store.get("VersionTrack/ver-1");
        expect(entry?.events.length).toBe(3);
        expect(entry?.events[0]?.version).toBe(1);
        expect(entry?.events[1]?.version).toBe(2);
        expect(entry?.events[2]?.version).toBe(3);
      }) as Effect.Effect<void>,
    );
  });

  // ---------------------------------------------------------------------------
  // 7. Journal + snapshot: reactivation from snapshot + tail events
  // ---------------------------------------------------------------------------
  test("journal: reactivation replays tail events after snapshot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const { storeRef, layer: adapterLayer } = yield* makeInMemoryPersistenceAdapter;

        const entity = toEntity(counterMachine, { type: "JournalSnap" });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entityLayer = EntityMachine.layer(entity, counterMachine as any, {
          initializeState: () => CounterState.Active({ count: 0 }),
          persistence: { strategy: "journal" },
        });

        const provideLayer = entityLayer.pipe(
          Layer.provide(ActorSystemDefault),
          Layer.provide(adapterLayer),
        );

        // First activation: increment 5 times
        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(entity, provideLayer);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("js-1")) as any;
            for (let i = 0; i < 5; i++) {
              yield* client.Send({ event: CounterEvent.Increment });
            }
          }),
        ).pipe(Effect.provide(TestShardingConfig));

        // Manually override snapshot at version 3 (simulating periodic snapshot)
        // Directly mutate store since deactivation already saved at v5
        const store = yield* Ref.get(storeRef);
        const entry = store.get("JournalSnap/js-1");
        if (entry !== undefined) {
          entry.snapshot = {
            state: CounterState.Active({ count: 3 }),
            version: 3,
            timestamp: Date.now(),
          };
        }

        // Second activation: should load snapshot (v3, count=3) + replay events 4,5
        yield* Effect.scoped(
          Effect.gen(function* () {
            const makeClient = yield* Entity.makeTestClient(entity, provideLayer);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const client = (yield* makeClient("js-1")) as any;
            const state = yield* client.GetState();
            expect(state._tag).toBe("Active");
            expect((state as { count: number }).count).toBe(5);
          }),
        ).pipe(Effect.provide(TestShardingConfig));
      }) as Effect.Effect<void>,
    );
  });
});
