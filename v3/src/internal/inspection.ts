import { Clock, Effect } from "effect";

import type { InspectionEvent, Inspector } from "../inspection.js";

/**
 * Emit an inspection event with timestamp from Clock.
 * @internal
 */
export const emitWithTimestamp = Effect.fn("effect-machine.emitWithTimestamp")(function* <S, E>(
  inspector: Inspector<S, E> | undefined,
  makeEvent: (timestamp: number) => InspectionEvent<S, E>,
) {
  if (inspector === undefined) {
    return;
  }
  const timestamp = yield* Clock.currentTimeMillis;
  const event = makeEvent(timestamp);
  const result = yield* Effect.sync(() => {
    try {
      return inspector.onInspect(event);
    } catch {
      return undefined;
    }
  });
  if (result !== undefined && Effect.isEffect(result)) {
    yield* (result as Effect.Effect<void>).pipe(Effect.catchAllCause(() => Effect.void));
  }
});
