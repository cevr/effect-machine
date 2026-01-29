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
import { Effect, Exit, Scope } from "effect";

import type { Machine, MachineRef, Transition, SpawnEffect, HandlerContext } from "../machine.js";
import type { GuardsDef, EffectsDef, MachineContext } from "../slot.js";
import { isEffect, INTERNAL_ENTER_EVENT } from "./utils.js";

// ============================================================================
// Transition Execution
// ============================================================================

/**
 * Result of executing a transition.
 */
export interface TransitionExecutionResult<S> {
  /** New state after transition (or current state if no transition matched) */
  readonly newState: S;
  /** Whether a transition was executed */
  readonly transitioned: boolean;
  /** Whether reenter was specified on the transition */
  readonly reenter: boolean;
}

/**
 * Execute a transition for a given state and event.
 * Handles transition resolution, handler invocation, and guard/effect slot creation.
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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
): Effect.Effect<TransitionExecutionResult<S>, never, R> =>
  Effect.gen(function* () {
    // Find matching transition
    const transition = resolveTransition(machine, currentState, event);

    if (transition === undefined) {
      return {
        newState: currentState,
        transitioned: false,
        reenter: false,
      };
    }

    // Create context for handler
    const ctx: MachineContext<S, E, MachineRef<E>> = {
      state: currentState,
      event,
      self,
    };
    const { guards, effects } = machine._createSlotAccessors(ctx);

    const handlerCtx: HandlerContext<S, E, GD, EFD> = {
      state: currentState,
      event,
      guards,
      effects,
    };

    // Compute new state - provide machine context for slot handlers
    const newStateResult = transition.handler(handlerCtx);
    const newState = isEffect(newStateResult)
      ? yield* (newStateResult as Effect.Effect<S, never, R>).pipe(
          Effect.provideService(machine.Context, ctx),
        )
      : newStateResult;

    return {
      newState,
      transitioned: true,
      reenter: transition.reenter === true,
    };
  });

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
}

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
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: { current: Scope.CloseableScope },
  hooks?: ProcessEventHooks<S, E>,
): Effect.Effect<ProcessEventResult<S>, never, R> =>
  Effect.gen(function* () {
    // Execute transition
    const result = yield* executeTransition(machine, currentState, event, self);

    if (!result.transitioned) {
      return {
        newState: currentState,
        previousState: currentState,
        transitioned: false,
        lifecycleRan: false,
        isFinal: false,
      };
    }

    const newState = result.newState;
    const stateTagChanged = newState._tag !== currentState._tag;
    const runLifecycle = stateTagChanged || result.reenter;

    if (runLifecycle) {
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
      yield* runSpawnEffects(machine, newState, enterEvent, self, stateScopeRef.current);
    }

    return {
      newState,
      previousState: currentState,
      transitioned: true,
      lifecycleRan: runLifecycle,
      isFinal: machine.finalStates.has(newState._tag),
    };
  });

/**
 * Run spawn effects for a state (forked into state scope, auto-cancelled on state exit).
 *
 * @internal
 */
export const runSpawnEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  event: E,
  self: MachineRef<E>,
  stateScope: Scope.CloseableScope,
): Effect.Effect<void, never, R> =>
  Effect.gen(function* () {
    const spawnEffects = findSpawnEffects(machine, state._tag);
    const ctx: MachineContext<S, E, MachineRef<E>> = { state, event, self };
    const { effects: effectSlots } = machine._createSlotAccessors(ctx);

    for (const spawnEffect of spawnEffects) {
      // Fork the spawn effect into the state scope - interrupted when scope closes
      yield* Effect.forkScoped(
        (
          spawnEffect.handler({ state, event, self, effects: effectSlots }) as Effect.Effect<
            void,
            never,
            R
          >
        ).pipe(Effect.provideService(machine.Context, ctx)),
      ).pipe(Effect.provideService(Scope.Scope, stateScope));
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
): (typeof machine.transitions)[number] | undefined => {
  const candidates = findTransitions(machine, currentState._tag, event._tag);
  return candidates[0];
};

// ============================================================================
// Transition Index (O(1) Lookup)
// ============================================================================

/**
 * Index structure: stateTag -> eventTag -> transitions[]
 * Array preserves registration order for guard cascade evaluation.
 */
type TransitionIndex<S, E, GD extends GuardsDef, EFD extends EffectsDef, R> = Map<
  string,
  Map<string, Array<Transition<S, E, GD, EFD, R>>>
>;

/**
 * Index for spawn effects: stateTag -> effects[]
 */
type SpawnIndex<S, E, EFD extends EffectsDef, R> = Map<string, Array<SpawnEffect<S, E, EFD, R>>>;

/**
 * Combined index for a machine
 */
interface MachineIndex<S, E, GD extends GuardsDef, EFD extends EffectsDef, R> {
  readonly transitions: TransitionIndex<S, E, GD, EFD, R>;
  readonly spawn: SpawnIndex<S, E, EFD, R>;
}

// Module-level cache - WeakMap allows GC of unreferenced machines
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const indexCache = new WeakMap<object, MachineIndex<any, any, any, any, any>>();

/**
 * Build transition index from machine definition.
 * O(n) where n = number of transitions.
 */
const buildTransitionIndex = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  GD extends GuardsDef,
  EFD extends EffectsDef,
  R,
>(
  transitions: ReadonlyArray<Transition<S, E, GD, EFD, R>>,
): TransitionIndex<S, E, GD, EFD, R> => {
  const index: TransitionIndex<S, E, GD, EFD, R> = new Map();

  for (const t of transitions) {
    let stateMap = index.get(t.stateTag);
    if (stateMap === undefined) {
      stateMap = new Map();
      index.set(t.stateTag, stateMap);
    }

    let eventList = stateMap.get(t.eventTag);
    if (eventList === undefined) {
      eventList = [];
      stateMap.set(t.eventTag, eventList);
    }

    eventList.push(t);
  }

  return index;
};

/**
 * Build spawn index from machine definition.
 */
const buildSpawnIndex = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  EFD extends EffectsDef,
  R,
>(
  effects: ReadonlyArray<SpawnEffect<S, E, EFD, R>>,
): SpawnIndex<S, E, EFD, R> => {
  const index: SpawnIndex<S, E, EFD, R> = new Map();

  for (const e of effects) {
    let stateList = index.get(e.stateTag);
    if (stateList === undefined) {
      stateList = [];
      index.set(e.stateTag, stateList);
    }
    stateList.push(e);
  }

  return index;
};

/**
 * Get or build index for a machine.
 */
const getIndex = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
): MachineIndex<S, E, GD, EFD, R> => {
  let index = indexCache.get(machine) as MachineIndex<S, E, GD, EFD, R> | undefined;
  if (index === undefined) {
    index = {
      transitions: buildTransitionIndex(machine.transitions),
      spawn: buildSpawnIndex(machine.spawnEffects),
    };
    indexCache.set(machine, index);
  }
  return index;
};

/**
 * Find all transitions matching a state/event pair.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
export const findTransitions = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateTag: string,
  eventTag: string,
): ReadonlyArray<Transition<S, E, GD, EFD, R>> => {
  const index = getIndex(machine);
  return index.transitions.get(stateTag)?.get(eventTag) ?? [];
};

/**
 * Find all spawn effects for a state.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
export const findSpawnEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateTag: string,
): ReadonlyArray<SpawnEffect<S, E, EFD, R>> => {
  const index = getIndex(machine);
  return index.spawn.get(stateTag) ?? [];
};
