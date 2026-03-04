import { Clock, Effect } from "effect";

//#region src-v3/internal/inspection.ts
/**
 * Emit an inspection event with timestamp from Clock.
 * @internal
 */
const emitWithTimestamp = Effect.fn("effect-machine.emitWithTimestamp")(
  function* (inspector, makeEvent) {
    if (inspector === void 0) return;
    const timestamp = yield* Clock.currentTimeMillis;
    yield* Effect.try(() => inspector.onInspect(makeEvent(timestamp))).pipe(Effect.ignore);
  },
);

//#endregion
export { emitWithTimestamp };
