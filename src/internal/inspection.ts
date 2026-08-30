import { Cause, Clock, Effect } from "effect";

import type { InspectionEvent, InspectorService } from "../inspection.js";
import type { ProcessEventHooks } from "./transition.js";

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
    yield* result.pipe(Effect.ignoreCause);
  }
});

/** Adapt the Inspector service to the transition kernel. */
// @effect-diagnostics missingPipeableSignature:off -- Internal fixed-arity adapter.
export const makeInspectionHooks = <S, E>(
  actorId: string,
  inspector: InspectorService<S, E>,
  getGeneration: () => number = () => 0,
): ProcessEventHooks<S, E> => ({
  onGuard: (evaluation) =>
    emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.guard",
      actorId,
      generation: getGeneration(),
      state: evaluation.state,
      event: evaluation.event,
      guard: evaluation.guard,
      result: evaluation.result,
      timestamp,
    })),
  onOperation: (operation) =>
    emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.operation",
      actorId,
      generation: getGeneration(),
      operation: operation.operation,
      state: operation.state,
      event: operation.event,
      timestamp,
    })),
  onSpawnEffect: (state) =>
    emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.effect",
      actorId,
      generation: getGeneration(),
      effectType: "spawn",
      state,
      timestamp,
    })),
  onTransition: (from, to, event) =>
    emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.transition",
      actorId,
      generation: getGeneration(),
      fromState: from,
      toState: to,
      event,
      timestamp,
    })),
  onError: (info) =>
    emitWithTimestamp(inspector, (timestamp) => ({
      type: "@machine.error",
      actorId,
      generation: getGeneration(),
      phase: info.phase,
      state: info.state,
      event: info.event,
      error: Cause.pretty(info.cause),
      timestamp,
    })),
});
