import { PersistenceAdapter, PersistenceAdapterTag } from "../adapter.js";
import { Effect, Layer } from "effect";

//#region src-v3/persistence/adapters/in-memory.d.ts
/**
 * Create an in-memory persistence adapter effect.
 * Returns the adapter directly for custom layer composition.
 */
declare const makeInMemoryPersistenceAdapter: Effect.Effect<PersistenceAdapter, never, never>;
/**
 * In-memory persistence adapter layer.
 * Data is not persisted across process restarts.
 *
 * NOTE: Each `Effect.provide(InMemoryPersistenceAdapter)` creates a NEW adapter
 * with empty storage. For tests that need persistent storage across multiple
 * runPromise calls, use `makeInMemoryPersistenceAdapter` with a shared scope.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const system = yield* ActorSystemService;
 *   const actor = yield* system.spawn("my-actor", persistentMachine);
 *   // ...
 * }).pipe(
 *   Effect.provide(InMemoryPersistenceAdapter),
 *   Effect.provide(ActorSystemDefault),
 * );
 * ```
 */
declare const InMemoryPersistenceAdapter: Layer.Layer<PersistenceAdapterTag>;
//#endregion
export { InMemoryPersistenceAdapter, makeInMemoryPersistenceAdapter };
