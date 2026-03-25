import { INTERNAL_ENTER_EVENT, isEffect } from "./utils.js";
import { BuiltMachine } from "../machine.js";
import { Cause, Effect, Exit, Scope } from "effect";
//#region src-v3/internal/transition.ts
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
/**
 * Run a transition handler and return the new state.
 * Shared logic for executing handlers with proper context.
 *
 * Used by:
 * - executeTransition (actor event loop, testing)
 * - persistent-actor replay (restore, replayTo)
 *
 * @internal
 */
const runTransitionHandler = Effect.fn("effect-machine.runTransitionHandler")(
  function* (machine, transition, state, event, self, system) {
    const ctx = {
      state,
      event,
      self,
      system,
    };
    const { guards, effects } = machine._slots;
    const handlerCtx = {
      state,
      event,
      guards,
      effects,
    };
    const result = transition.handler(handlerCtx);
    return isEffect(result)
      ? yield* result.pipe(Effect.provideService(machine.Context, ctx))
      : result;
  },
);
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
const executeTransition = Effect.fn("effect-machine.executeTransition")(
  function* (machine, currentState, event, self, system) {
    const transition = resolveTransition(machine, currentState, event);
    if (transition === void 0)
      return {
        newState: currentState,
        transitioned: false,
        reenter: false,
      };
    return {
      newState: yield* runTransitionHandler(machine, transition, currentState, event, self, system),
      transitioned: true,
      reenter: transition.reenter === true,
    };
  },
);
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
const processEventCore = Effect.fn("effect-machine.processEventCore")(
  function* (machine, currentState, event, self, stateScopeRef, system, hooks) {
    const result = yield* executeTransition(machine, currentState, event, self, system).pipe(
      Effect.catchAllCause((cause) => {
        if (Cause.isInterruptedOnly(cause)) return Effect.interrupt;
        const onError = hooks?.onError;
        if (onError === void 0) return Effect.failCause(cause).pipe(Effect.orDie);
        return onError({
          phase: "transition",
          state: currentState,
          event,
          cause,
        }).pipe(Effect.zipRight(Effect.failCause(cause).pipe(Effect.orDie)));
      }),
    );
    if (!result.transitioned)
      return {
        newState: currentState,
        previousState: currentState,
        transitioned: false,
        lifecycleRan: false,
        isFinal: false,
      };
    const newState = result.newState;
    const runLifecycle = newState._tag !== currentState._tag || result.reenter;
    if (runLifecycle) {
      yield* Scope.close(stateScopeRef.current, Exit.void);
      stateScopeRef.current = yield* Scope.make();
      if (hooks?.onTransition !== void 0) yield* hooks.onTransition(currentState, newState, event);
      if (hooks?.onSpawnEffect !== void 0) yield* hooks.onSpawnEffect(newState);
      yield* runSpawnEffects(
        machine,
        newState,
        { _tag: INTERNAL_ENTER_EVENT },
        self,
        stateScopeRef.current,
        system,
        hooks?.onError,
      );
    }
    return {
      newState,
      previousState: currentState,
      transitioned: true,
      lifecycleRan: runLifecycle,
      isFinal: machine.finalStates.has(newState._tag),
    };
  },
);
/**
 * Run spawn effects for a state (forked into state scope, auto-cancelled on state exit).
 *
 * @internal
 */
const runSpawnEffects = Effect.fn("effect-machine.runSpawnEffects")(
  function* (machine, state, event, self, stateScope, system, onError) {
    const spawnEffects = findSpawnEffects(machine, state._tag);
    const ctx = {
      state,
      event,
      self,
      system,
    };
    const { effects: effectSlots } = machine._slots;
    const reportError = onError;
    for (const spawnEffect of spawnEffects) {
      const effect = spawnEffect
        .handler({
          state,
          event,
          self,
          effects: effectSlots,
          system,
        })
        .pipe(
          Effect.provideService(machine.Context, ctx),
          Effect.catchAllCause((cause) => {
            if (Cause.isInterruptedOnly(cause)) return Effect.interrupt;
            if (reportError === void 0) return Effect.failCause(cause).pipe(Effect.orDie);
            return reportError({
              phase: "spawn",
              state,
              event,
              cause,
            }).pipe(Effect.zipRight(Effect.failCause(cause).pipe(Effect.orDie)));
          }),
        );
      yield* Effect.forkScoped(effect).pipe(Effect.provideService(Scope.Scope, stateScope));
    }
  },
);
/**
 * Resolve which transition should fire for a given state and event.
 * Uses indexed O(1) lookup. First matching transition wins.
 */
const resolveTransition = (machine, currentState, event) => {
  return findTransitions(machine, currentState._tag, event._tag)[0];
};
const indexCache = /* @__PURE__ */ new WeakMap();
/**
 * Invalidate cached index for a machine (call after mutation).
 */
const invalidateIndex = (machine) => {
  indexCache.delete(machine);
};
/**
 * Build transition index from machine definition.
 * O(n) where n = number of transitions.
 */
const buildTransitionIndex = (transitions) => {
  const index = /* @__PURE__ */ new Map();
  for (const t of transitions) {
    let stateMap = index.get(t.stateTag);
    if (stateMap === void 0) {
      stateMap = /* @__PURE__ */ new Map();
      index.set(t.stateTag, stateMap);
    }
    let eventList = stateMap.get(t.eventTag);
    if (eventList === void 0) {
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
const buildSpawnIndex = (effects) => {
  const index = /* @__PURE__ */ new Map();
  for (const e of effects) {
    let stateList = index.get(e.stateTag);
    if (stateList === void 0) {
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
const getIndex = (machine) => {
  let index = indexCache.get(machine);
  if (index === void 0) {
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
 * Accepts both `Machine` and `BuiltMachine`.
 * O(1) lookup after first access (index is lazily built).
 */
const findTransitions = (input, stateTag, eventTag) => {
  const index = getIndex(input instanceof BuiltMachine ? input._inner : input);
  const specific = index.transitions.get(stateTag)?.get(eventTag) ?? [];
  if (specific.length > 0) return specific;
  return index.transitions.get("*")?.get(eventTag) ?? [];
};
/**
 * Find all spawn effects for a state.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
const findSpawnEffects = (machine, stateTag) => {
  return getIndex(machine).spawn.get(stateTag) ?? [];
};
//#endregion
export {
  executeTransition,
  findSpawnEffects,
  findTransitions,
  invalidateIndex,
  processEventCore,
  resolveTransition,
  runSpawnEffects,
  runTransitionHandler,
};
