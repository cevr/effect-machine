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

interface ExecutedStep<S, E> {
  readonly previousState: S;
  readonly newState: S;
  readonly event: E;
  readonly transition: Transition<S, E, never>;
}

interface ExecutedTransition<S, E = unknown> {
  readonly newState: S;
  readonly transitioned: boolean;
  readonly reenter: boolean;
  readonly hasReply: boolean;
  readonly deferReply: boolean;
  readonly reply: unknown;
  readonly transition?: Transition<S, E, never>;
  readonly steps: ReadonlyArray<ExecutedStep<S, E>>;
}

const completeTransition = <S, E>(
  currentState: S,
  event: E,
  transition: Transition<S, E, never>,
  resolved: S | ReplyResult<S, unknown> | DeferReplyResult<S>,
): ExecutedTransition<S, E> => {
  if (isReplyResult(resolved)) {
    return {
      newState: resolved.state,
      transitioned: true,
      reenter: transition.reenter === true,
      hasReply: true,
      deferReply: false,
      reply: resolved.reply,
      transition,
      steps: [{ previousState: currentState, newState: resolved.state, event, transition }],
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
      transition,
      steps: [{ previousState: currentState, newState: resolved.state, event, transition }],
    };
  }

  return {
    newState: resolved,
    transitioned: true,
    reenter: transition.reenter === true,
    hasReply: false,
    deferReply: false,
    reply: undefined,
    transition,
    steps: [{ previousState: currentState, newState: resolved, event, transition }],
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
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
) =>
  Effect.suspend(() => {
    const result = executeTransitionImmediate(machine, currentState, event);
    let first: Effect.Effect<ExecutedTransition<S, E>>;
    if (isEffect(result)) {
      first = result;
    } else {
      first = Effect.succeed(result);
    }
    return first.pipe(
      Effect.flatMap((initialResult) =>
        stabilizeTransition(machine, currentState, event, initialResult),
      ),
    );
  });

/**
 * Execute a transition without adding an Effect boundary for a synchronous handler.
 * A throwing handler becomes a defect Effect.
 *
 * @internal
 */
const executeTransitionCandidatesImmediate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
>(
  currentState: S,
  event: E,
  candidates: ReadonlyArray<Transition<S, E, never>>,
  hooks?: ProcessEventHooks<S, E>,
): ExecutedTransition<S, E> | Effect.Effect<ExecutedTransition<S, E>> => {
  let resolution: TransitionResolution<S, E> | Effect.Effect<TransitionResolution<S, E>>;
  try {
    resolution = evaluateTransitions(candidates, currentState, event);
  } catch (defect) {
    return Effect.die(defect);
  }

  const executeResolved = (
    resolved: TransitionResolution<S, E>,
  ): ExecutedTransition<S, E> | Effect.Effect<ExecutedTransition<S, E>> => {
    const transition = resolved.transition;

    if (transition === undefined) {
      const unhandled: ExecutedTransition<S, E> = {
        newState: currentState,
        transitioned: false as const,
        reenter: false,
        hasReply: false,
        deferReply: false,
        reply: undefined,
        transition: undefined,
        steps: [],
      };
      if (hooks?.onGuard === undefined || resolved.evaluations.length === 0) return unhandled;
      return Effect.forEach(resolved.evaluations, hooks.onGuard, { discard: true }).pipe(
        Effect.as(unhandled),
      );
    }

    const runHandler = (): ExecutedTransition<S, E> | Effect.Effect<ExecutedTransition<S, E>> => {
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
          Effect.map((value) => completeTransition(currentState, event, transition, value)),
        );
      }

      return completeTransition(currentState, event, transition, raw);
    };

    if (hooks?.onGuard === undefined || resolved.evaluations.length === 0) return runHandler();
    return Effect.forEach(resolved.evaluations, hooks.onGuard, { discard: true }).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          const result = runHandler();
          if (isEffect(result)) return result;
          return Effect.succeed(result);
        }),
      ),
    );
  };

  if (!isEffect(resolution)) return executeResolved(resolution);
  return resolution.pipe(
    Effect.flatMap((resolved) => {
      const result = executeResolved(resolved);
      if (isEffect(result)) return result;
      return Effect.succeed(result);
    }),
  );
};

export const executeTransitionImmediate = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
  hooks?: ProcessEventHooks<S, E>,
): ExecutedTransition<S, E> | Effect.Effect<ExecutedTransition<S, E>> =>
  executeTransitionCandidatesImmediate(
    currentState,
    event,
    machine._findTransitions(currentState._tag, event._tag),
    hooks,
  );

const stabilizeTransition = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any, any, any>,
  initialState: S,
  event: E,
  result: ExecutedTransition<S, E>,
  hooks?: ProcessEventHooks<S, E>,
) =>
  Effect.gen(function* () {
    const steps = [...result.steps];
    let stableState = result.newState;
    let lifecycleRequired = result.reenter || stableState._tag !== initialState._tag;
    let depth = 0;

    while (true) {
      const candidates = machine._findImmediateTransitions(stableState._tag);
      if (candidates.length === 0) break;
      depth += 1;
      if (depth > 100) {
        return yield* Effect.die(
          new Error("Immediate transition limit exceeded. Check for an eventless loop."),
        );
      }
      const immediate = executeTransitionCandidatesImmediate(stableState, event, candidates, hooks);
      let next: ExecutedTransition<S, E>;
      if (isEffect(immediate)) {
        next = yield* immediate;
      } else {
        next = immediate;
      }
      if (!next.transitioned) break;
      if (next.reenter || next.newState._tag !== stableState._tag) lifecycleRequired = true;
      steps.push(...next.steps);
      stableState = next.newState;
    }

    return {
      ...result,
      newState: stableState,
      transitioned: steps.length > 0,
      reenter: lifecycleRequired,
      transition: steps.at(-1)?.transition,
      steps,
    } satisfies ExecutedTransition<S, E>;
  });

// ============================================================================
// Event Processing Core (shared by actor and entity-machine)
// ============================================================================

/**
 * Optional hooks for event processing inspection/tracing.
 */
export interface ProcessEventHooks<S, E> {
  /** Called after each guard candidate is evaluated. */
  readonly onGuard?: (evaluation: GuardEvaluation<S, E>) => Effect.Effect<void>;
  /** Called before running spawn effects */
  readonly onSpawnEffect?: (state: S) => Effect.Effect<void>;
  /** Called after transition completes */
  readonly onTransition?: (from: S, to: S, event: E) => Effect.Effect<void>;
  /** Called when a transition handler or spawn effect fails with a defect */
  readonly onError?: (info: ProcessEventError<S, E>) => Effect.Effect<void>;
  /** Called when a forked spawn fiber defects — signals the runtime to set exitDeferred */
  readonly onSpawnDefect?: (cause: Cause.Cause<unknown>) => Effect.Effect<void>;
}

export interface GuardEvaluation<S, E> {
  readonly guard: string;
  readonly state: S;
  readonly event: E;
  readonly params: unknown;
  readonly result: boolean;
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
export interface ProcessEventResult<S, E = unknown> {
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
  /** Each accepted edge in the stable macrostep. */
  readonly transitions: ReadonlyArray<{
    readonly previousState: S;
    readonly newState: S;
    readonly event: E;
  }>;
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
  machine: Machine<S, E, R, any, any, any, any>,
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
  machine: Machine<S, E, R, any, any, any, any>,
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
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
  result: ExecutedTransition<S, E>,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  system: ActorSystemService,
  actorId: string,
  hooks?: ProcessEventHooks<S, E>,
):
  | ProcessEventResult<S, E>
  | Effect.Effect<ProcessEventResult<S, E>, never, Exclude<R, Scope.Scope>> => {
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
      transitions: [],
    };
  }

  const newState = result.newState;
  const runLifecycle = newState._tag !== currentState._tag || result.reenter;
  const processed: ProcessEventResult<S, E> = {
    newState,
    previousState: currentState,
    transitioned: true,
    lifecycleRan: runLifecycle,
    isFinal: machine._isFinal(newState._tag),
    hasReply: result.hasReply,
    deferReply: result.deferReply,
    reply: result.reply,
    postponed: false,
    transitions: result.steps,
  };
  const observeTransitions = hooks?.onTransition;
  if (!runLifecycle) {
    if (observeTransitions === undefined || result.steps.length === 0) return processed;
    return Effect.forEach(
      result.steps,
      (step) => observeTransitions(step.previousState, step.newState, step.event),
      { discard: true },
    ).pipe(Effect.as(processed));
  }

  return Effect.gen(function* () {
    // Close old state scope (interrupts spawn fibers)
    yield* Scope.close(stateScopeRef.current, Exit.void);

    // Create new state scope
    stateScopeRef.current = yield* Scope.make();

    // Hook: transition complete (before spawn effects)
    if (observeTransitions !== undefined) {
      yield* Effect.forEach(
        result.steps,
        (step) => observeTransitions(step.previousState, step.newState, step.event),
        { discard: true },
      );
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
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.Closeable },
  system: ActorSystemService,
  actorId: string,
  hooks?: ProcessEventHooks<S, E>,
) => {
  const execution = executeTransitionImmediate(machine, currentState, event, hooks);
  const complete = (result: ExecutedTransition<S, E>) => {
    const immediateCandidates = machine._findImmediateTransitions(result.newState._tag);
    if (immediateCandidates.length === 0) {
      return completeProcessedEvent(
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
    }

    return Effect.gen(function* () {
      const steps = [...result.steps];
      let stableState = result.newState;
      let lifecycleRequired = result.reenter || stableState._tag !== currentState._tag;
      let depth = 0;

      while (true) {
        const candidates = machine._findImmediateTransitions(stableState._tag);
        if (candidates.length === 0) break;
        depth += 1;
        if (depth > 100) {
          return yield* Effect.die(
            new Error("Immediate transition limit exceeded. Check for an eventless loop."),
          );
        }
        const immediate = executeTransitionCandidatesImmediate(
          stableState,
          event,
          candidates,
          hooks,
        );
        let next: ExecutedTransition<S, E>;
        if (isEffect(immediate)) {
          next = yield* immediate;
        } else {
          next = immediate;
        }
        if (!next.transitioned) break;
        if (next.reenter || next.newState._tag !== stableState._tag) lifecycleRequired = true;
        steps.push(...next.steps);
        stableState = next.newState;
      }

      const processed = completeProcessedEvent(
        machine,
        currentState,
        event,
        {
          ...result,
          newState: stableState,
          transitioned: steps.length > 0,
          reenter: lifecycleRequired,
          transition: steps.at(-1)?.transition,
          steps,
        },
        self,
        stateScopeRef,
        system,
        actorId,
        hooks,
      );
      if (isEffect(processed)) return yield* processed;
      return processed;
    });
  };
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
  machine: Machine<S, E, R, any, any, any, any>,
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
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
): Transition<S, E, never> | undefined => {
  const resolution = evaluateTransitions(
    machine._findTransitions(currentState._tag, event._tag),
    currentState,
    event,
  );
  if (isEffect(resolution)) {
    return Effect.runSync(
      Effect.die("Effect guards require actor.can(event). actor.sync.can(event) is synchronous."),
    );
  }
  return resolution.transition;
};

/** Resolve a transition with pure or Effect guards. */
export const resolveTransitionEffect = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
): Effect.Effect<Transition<S, E, never> | undefined> => {
  const resolution = evaluateTransitions(
    machine._findTransitions(currentState._tag, event._tag),
    currentState,
    event,
  );
  if (isEffect(resolution)) return resolution.pipe(Effect.map((value) => value.transition));
  return Effect.succeed(resolution.transition);
};

interface TransitionResolution<S, E> {
  readonly transition: Transition<S, E, never> | undefined;
  readonly evaluations: ReadonlyArray<GuardEvaluation<S, E>>;
}

const evaluateTransitions = <S, E>(
  candidates: ReadonlyArray<Transition<S, E, never>>,
  currentState: S,
  event: E,
): TransitionResolution<S, E> | Effect.Effect<TransitionResolution<S, E>> => {
  const ctx: HandlerContext<S, E> = { state: currentState, event };
  const loop = (
    index: number,
    evaluations: ReadonlyArray<GuardEvaluation<S, E>>,
  ): TransitionResolution<S, E> | Effect.Effect<TransitionResolution<S, E>> => {
    const candidate = candidates[index];
    if (candidate === undefined) return { transition: undefined, evaluations };
    if (candidate.guard === undefined) return { transition: candidate, evaluations };

    const guardName = candidate.guard.name || "<inline>";
    const result = candidate.guard(ctx);
    const continueWith = (
      passed: boolean,
    ): TransitionResolution<S, E> | Effect.Effect<TransitionResolution<S, E>> => {
      const nextEvaluations = [
        ...evaluations,
        {
          guard: guardName,
          state: currentState,
          event,
          params: undefined,
          result: passed,
        },
      ];
      if (passed) return { transition: candidate, evaluations: nextEvaluations };
      return loop(index + 1, nextEvaluations);
    };

    if (!isEffect(result)) return continueWith(result);
    return result.pipe(
      Effect.flatMap((passed) => {
        const next = continueWith(passed);
        if (isEffect(next)) return next;
        return Effect.succeed(next);
      }),
    );
  };

  return loop(0, []);
};
