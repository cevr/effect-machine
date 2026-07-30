import { Clock, Effect } from "effect";

import type { InspectionEvent, InspectorService } from "../inspection.js";

/**
 * Emit an inspection event with timestamp from Clock.
 * @internal
 */
export const emitWithTimestamp = Effect.fn("effect-machine.emitWithTimestamp")(function* <S, E>(
  inspector: InspectorService<S, E> | undefined,
  makeEvent: (timestamp: number) => InspectionEvent<S, E>,
) {
  if (inspector === undefined) {
    return;
  }
  const timestamp = yield* Clock.currentTimeMillis;
  const event = makeEvent(timestamp);
  // onInspect is user-supplied and may throw; a failing inspector must never
  // break the machine it observes.
  const result = yield* Effect.try(() => inspector.onInspect(event)).pipe(
    Effect.orElseSucceed(() => undefined),
  );
  if (Effect.isEffect(result)) {
    yield* result.pipe(Effect.catchCause(() => Effect.void));
  }
});
