/**
 * Transition index for O(1) lookup by state/event tag.
 *
 * Uses a WeakMap cache to avoid memory leaks - machine references
 * can be garbage collected normally.
 *
 * @internal
 */
import type { Machine, Transition, AlwaysTransition } from "../machine.js";

/**
 * Index structure: stateTag -> eventTag -> transitions[]
 * Array preserves registration order for guard cascade evaluation.
 */
type TransitionIndex<S, E, R> = Map<string, Map<string, Array<Transition<S, E, R>>>>;

/**
 * Index for always transitions: stateTag -> transitions[]
 */
type AlwaysIndex<S, R> = Map<string, Array<AlwaysTransition<S, R>>>;

/**
 * Combined index for a machine
 */
interface MachineIndex<S, E, R> {
  readonly transitions: TransitionIndex<S, E, R>;
  readonly always: AlwaysIndex<S, R>;
}

// Module-level cache - WeakMap allows GC of unreferenced machines
const indexCache = new WeakMap<object, MachineIndex<unknown, unknown, unknown>>();

/**
 * Build transition index from machine definition.
 * O(n) where n = number of transitions.
 */
const buildTransitionIndex = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  transitions: ReadonlyArray<Transition<S, E, R>>,
): TransitionIndex<S, E, R> => {
  const index: TransitionIndex<S, E, R> = new Map();

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
 * Build always transition index from machine definition.
 */
const buildAlwaysIndex = <S extends { readonly _tag: string }, R>(
  transitions: ReadonlyArray<AlwaysTransition<S, R>>,
): AlwaysIndex<S, R> => {
  const index: AlwaysIndex<S, R> = new Map();

  for (const t of transitions) {
    let stateList = index.get(t.stateTag);
    if (stateList === undefined) {
      stateList = [];
      index.set(t.stateTag, stateList);
    }
    stateList.push(t);
  }

  return index;
};

/**
 * Get or build index for a machine.
 */
const getIndex = <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: Machine<S, E, R>,
): MachineIndex<S, E, R> => {
  let index = indexCache.get(machine) as MachineIndex<S, E, R> | undefined;
  if (index === undefined) {
    index = {
      transitions: buildTransitionIndex(machine.transitions),
      always: buildAlwaysIndex(machine.alwaysTransitions),
    };
    indexCache.set(machine, index as MachineIndex<unknown, unknown, unknown>);
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
>(
  machine: Machine<S, E, R>,
  stateTag: string,
  eventTag: string,
): ReadonlyArray<Transition<S, E, R>> => {
  const index = getIndex(machine);
  return index.transitions.get(stateTag)?.get(eventTag) ?? [];
};

/**
 * Find all always transitions for a state.
 * Returns empty array if no matches.
 */
export const findAlwaysTransitions = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: Machine<S, E, R>,
  stateTag: string,
): ReadonlyArray<AlwaysTransition<S, R>> => {
  const index = getIndex(machine);
  return index.always.get(stateTag) ?? [];
};
