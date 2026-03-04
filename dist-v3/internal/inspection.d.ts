import { InspectionEvent, Inspector } from "../inspection.js";
import { Effect } from "effect";

//#region src-v3/internal/inspection.d.ts
/**
 * Emit an inspection event with timestamp from Clock.
 * @internal
 */
declare const emitWithTimestamp: <S, E>(
  inspector: Inspector<S, E> | undefined,
  makeEvent: (timestamp: number) => InspectionEvent<S, E>,
) => Effect.Effect<void, never, never>;
//#endregion
export { emitWithTimestamp };
