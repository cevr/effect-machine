/**
 * Transition execution and indexing.
 *
 * Combines:
 * - Transition execution logic (for event processing, simulation, test harness)
 * - Event processing core (shared between actor and cluster entity)
 * - O(1) indexed lookup by state/event tag
 *
 * @internal
 */
import { Cause, Effect, Exit, Scope } from "effect";

import type { Machine, MachineRef, HandlerContext } from "../machine.js";
import type { ActorSystemService } from "../actor.js";
import type { Transition } from "./machine-definition.js";
import { isEffect, isReplyResult, isDeferReplyResult, INTERNAL_ENTER_EVENT } from "./utils.js";
import type { ReplyResult, DeferReplyResult } from "./utils.js";

interface ExecutedTransition<S> {
  readonly newState: S;
  readonly transitioned: boolean;
  readonly reenter: boolean;
  readonly hasReply: boolean;
  readonly deferReply: boolean;
  readonly reply: unknown;
}

const completeTransition = <S, E>(
  transition: Transition<S, E, never>,
  resolved: S | ReplyResult<S, unknown> | DeferReplyResult<S>,
): ExecutedTransition<S> => {
  if (isReplyResult(resolved)) {
    return {
      newState: resolved.state,
      transitioned: true,
      reenter: transition.reenter === true,
      hasReply: true,
      deferReply: false,
      reply: resolved.reply,
    };
  }

  if (isDeferReplyResult(resolved)) {
    return {
      newState: resolved.state,
      transitioned: true,
      reenter: transition.reenter === true,
      hasReply: false,
      deferReply: true,
      reply: undefined,
    };
  }

  return {
    newState: resolved,
    transitioned: true,
    reenter: transition.reenter === true,
    hasReply: false,
    deferReply: false,
    reply: undefined,
  };
};

/**
 * Execute a transition for a given state and event.
 * Handles transition resolution and handler invocation.
 *
 * Used by:
 * - processEvent in actor.ts (actual actor event loop)
 * - simulate in testing.ts (pure transition simulation)
 * - createTestHarness.send in testing.ts (step-by-step testing)
 *
 * @internal
 */
export const executeTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
) =>
  Effect.suspend(() => {
    const result = executeTransitionImmediate(machine, currentState, event);
    if (isEffect(result)) {
      return result;
    }
    return Effect.succeed(result);
  });

/**
 * Execute a transition without adding an Effect boundary for a synchronous handler.
 * A throwing handler becomes a defect Effect.
 *
 * @internal
 */
export const executeTransitionImmediate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
): ExecutedTransition<S> | Effect.Effect<ExecutedTransition<S>> => {
  const transition = resolveTransition(machine, currentState, event);

  if (transition === undefined) {
    return {
      newState: currentState,
      transitioned: false as const,
      reenter: false,
      hasReply: false,
      deferReply: false,
      reply: undefined,
    };
  }

  const handlerCtx: HandlerContext<S, E> = { state: currentState, event };
  let raw: ReturnType<typeof transition.handler>;
  try {
    raw = transition.handler(handlerCtx);
  } catch (defect) {
    return Effect.die(defect);
  }
  type HandlerResult = S | ReplyResult<S, unknown> | DeferReplyResult<S>;

  if (isEffect(raw)) {
    // SAFETY: The transition type fixes the state and error domains.
    return (raw as Effect.Effect<HandlerResult, never>).pipe(
      Effect.map((resolved) => completeTransition(transition, resolved)),
    );
  }

  return completeTransition(transition, raw);
};

// ============================================================================
// Event Processing Core (shared by actor and entity-machine)
// ============================================================================

/**
 * Optional hooks for event processing inspection/tracing.
 */
export interface ProcessEventHooks<S, E> {
  /** Called before running spawn effects */
  readonly onSpawnEffect?: (state: S) => Effect.Effect<void>;
  /** Called after transition completes */
  readonly onTransition?: (from: S, to: S, event: E) => Effect.Effect<void>;
  /** Called when a transition handler or spawn effect fails with a defect */
  readonly onError?: (info: ProcessEventError<S, E>) => Effect.Effect<void>;
  /** Called when a forked spawn fiber defects — signals the runtime to set exitDeferred */
  readonly onSpawnDefect?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

/**
 * Error info for inspection hooks.
 */
export interface ProcessEventError<S, E> {
  readonly phase: "transition" | "spawn";
  readonly state: S;
  readonly event: E;
  readonly cause: Cause.Cause<unknown>;
}

/**
 * Result of processing an event through the machine.
 */
export interface ProcessEventResult<S> {
  /** New state after processing */
  readonly newState: S;
  /** Previous state before processing */
  readonly previousState: S;
  /** Whether a transition occurred */
  readonly transitioned: boolean;
  /** Whether lifecycle effects ran (state change or reenter) */
  readonly lifecycleRan: boolean;
  /** Whether new state is final */
  readonly isFinal: boolean;
  /** Whether the handler provided a reply (structural, not value-based) */
  readonly hasReply: boolean;
  /** Whether the handler deferred the reply to a spawn handler (Machine.deferReply) */
  readonly deferReply: boolean;
  /** Domain reply value from handler (used by ask). Only meaningful when hasReply is true. */
  readonly reply?: unknown;
  /** Whether the event was postponed (buffered for retry after next state change) */
  readonly postponed: boolean;
}

/**
 * Check if an event should be postponed in the current state.
 * @internal
 */
export const shouldPostpone = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  stateTag: string,
  eventTag: string,
): boolean => machine._shouldPostpone(stateTag, eventTag);

/**
 * Process a single event through the machine.
 *
 * Handles:
 * - Transition execution
 * - State scope lifecycle (close old, create new)
 * - Running spawn effects
 *
 * Optional hooks allow inspection/tracing without coupling to specific impl.
 *
 * @internal
 */
export const processEventCore = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  system: ActorSystemService,
  actorId: string,
  hooks?: ProcessEventHooks<S, E>,
) =>
  Effect.suspend(() => {
    const processed = processEventCoreImmediate(
      machine,
      currentState,
      event,
      self,
      stateScopeRef,
      system,
      actorId,
      hooks,
    );
    if (isEffect(processed)) return processed;
    return Effect.succeed(processed);
  });

const completeProcessedEvent = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
  result: ExecutedTransition<S>,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  system: ActorSystemService,
  actorId: string,
  hooks?: ProcessEventHooks<S, E>,
): ProcessEventResult<S> | Effect.Effect<ProcessEventResult<S>, never, Exclude<R, Scope.Scope>> => {
  if (!result.transitioned) {
    return {
      newState: currentState,
      previousState: currentState,
      transitioned: false,
      lifecycleRan: false,
      isFinal: false,
      hasReply: false,
      deferReply: false,
      reply: undefined,
      postponed: false,
    };
  }

  const newState = result.newState;
  const runLifecycle = newState._tag !== currentState._tag || result.reenter;
  const processed: ProcessEventResult<S> = {
    newState,
    previousState: currentState,
    transitioned: true,
    lifecycleRan: runLifecycle,
    isFinal: machine._isFinal(newState._tag),
    hasReply: result.hasReply,
    deferReply: result.deferReply,
    reply: result.reply,
    postponed: false,
  };
  if (!runLifecycle) return processed;

  return Effect.gen(function* () {
    // Close old state scope (interrupts spawn fibers)
    yield* Scope.close(stateScopeRef.current, Exit.void);

    // Create new state scope
    stateScopeRef.current = yield* Scope.make();

    // Hook: transition complete (before spawn effects)
    if (hooks?.onTransition !== undefined) {
      yield* hooks.onTransition(currentState, newState, event);
    }

    // Hook: about to run spawn effects
    if (hooks?.onSpawnEffect !== undefined) {
      yield* hooks.onSpawnEffect(newState);
    }

    // Run spawn effects for new state
    const enterEvent = { _tag: INTERNAL_ENTER_EVENT } as E;
    yield* runSpawnEffects(
      machine,
      newState,
      enterEvent,
      self,
      stateScopeRef.current,
      system,
      actorId,
      hooks?.onError,
      hooks?.onSpawnDefect,
    );
    return processed;
  });
};

/** @internal */
export const processEventCoreImmediate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  system: ActorSystemService,
  actorId: string,
  hooks?: ProcessEventHooks<S, E>,
) => {
  const execution = executeTransitionImmediate(machine, currentState, event);
  const complete = (result: ExecutedTransition<S>) =>
    completeProcessedEvent(
      machine,
      currentState,
      event,
      result,
      self,
      stateScopeRef,
      system,
      actorId,
      hooks,
    );
  if (!isEffect(execution)) return complete(execution);

  return execution.pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
      const onError = hooks?.onError;
      if (onError === undefined) return Effect.failCause(cause).pipe(Effect.orDie);
      return onError({ phase: "transition", state: currentState, event, cause }).pipe(
        Effect.andThen(Effect.failCause(cause).pipe(Effect.orDie)),
      );
    }),
    Effect.flatMap((result) => {
      const processed = complete(result);
      if (isEffect(processed)) return processed;
      return Effect.succeed(processed);
    }),
  );
};

/**
 * Run spawn effects for a state (forked into state scope, auto-cancelled on state exit).
 *
 * @internal
 */
export const runSpawnEffects = Effect.fn("effect-machine.runSpawnEffects")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  state: S,
  event: E,
  self: MachineRef<E>,
  stateScope: Scope.Closeable,
  system: ActorSystemService,
  actorId: string,
  onError?: (info: ProcessEventError<S, E>) => Effect.Effect<void>,
  onSpawnDefect?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>,
) {
  const spawnEffects = machine._findSpawnEffects(state._tag);
  const reportError = onError;
  const defectSignal = onSpawnDefect;

  for (const spawnEffect of spawnEffects) {
    // Fork the spawn effect into the state scope - interrupted when scope closes
    const effect = spawnEffect
      .handler({
        actorId,
        state,
        event,
        self,
        system,
      })
      .pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) {
            return Effect.interrupt;
          }
          let report: Effect.Effect<void> = Effect.void;
          if (reportError !== undefined) {
            report = reportError({ phase: "spawn", state, event, cause });
          }
          // Signal spawn defect to runtime (if provided) so it can set exitDeferred
          let signal: Effect.Effect<void> = Effect.void;
          if (defectSignal !== undefined) {
            signal = defectSignal(cause);
          }
          return report.pipe(
            Effect.andThen(signal),
            Effect.andThen(Effect.failCause(cause).pipe(Effect.orDie)),
          );
        }),
      );

    yield* Effect.forkScoped(effect).pipe(Effect.provideService(Scope.Scope, stateScope));
  }
});

/**
 * Resolve which transition should fire for a given state and event.
 * Uses indexed O(1) lookup. First matching transition wins.
 */
export const resolveTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any>,
  currentState: S,
  event: E,
): Transition<S, E, never> | undefined => {
  const candidates = machine._findTransitions(currentState._tag, event._tag);
  return candidates[0];
};
