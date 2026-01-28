/**
 * Transition index for O(1) lookup by state/event tag.
 *
 * Uses a WeakMap cache to avoid memory leaks - machine references
 * can be garbage collected normally.
 *
 * @internal
 */
import type { Machine, Transition, AlwaysTransition, StateEffect } from "../machine.js";
import type { GuardsDef, EffectsDef } from "../slot.js";

/**
 * Index structure: stateTag -> eventTag -> transitions[]
 * Array preserves registration order for guard cascade evaluation.
 */
type TransitionIndex<S, E, GD extends GuardsDef, EFD extends EffectsDef, R> = Map<
  string,
  Map<string, Array<Transition<S, E, GD, EFD, R>>>
>;

/**
 * Index for always transitions: stateTag -> transitions[]
 */
type AlwaysIndex<S, GD extends GuardsDef, EFD extends EffectsDef, R> = Map<
  string,
  Array<AlwaysTransition<S, GD, EFD, R>>
>;

/**
 * Index for state effects: stateTag -> effects[]
 */
type EffectIndex<S, E, EFD extends EffectsDef, R> = Map<string, Array<StateEffect<S, E, EFD, R>>>;

/**
 * Combined index for a machine
 */
interface MachineIndex<S, E, GD extends GuardsDef, EFD extends EffectsDef, R> {
  readonly transitions: TransitionIndex<S, E, GD, EFD, R>;
  readonly always: AlwaysIndex<S, GD, EFD, R>;
  readonly onEnter: EffectIndex<S, E, EFD, R>;
  readonly onExit: EffectIndex<S, E, EFD, R>;
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
 * Build always transition index from machine definition.
 */
const buildAlwaysIndex = <
  S extends { readonly _tag: string },
  GD extends GuardsDef,
  EFD extends EffectsDef,
  R,
>(
  transitions: ReadonlyArray<AlwaysTransition<S, GD, EFD, R>>,
): AlwaysIndex<S, GD, EFD, R> => {
  const index: AlwaysIndex<S, GD, EFD, R> = new Map();

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
 * Build effect index from machine definition.
 */
const buildEffectIndex = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  EFD extends EffectsDef,
  R,
>(
  effects: ReadonlyArray<StateEffect<S, E, EFD, R>>,
): EffectIndex<S, E, EFD, R> => {
  const index: EffectIndex<S, E, EFD, R> = new Map();

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
  machine: Machine<S, E, R, never, any, any, GD, EFD>,
): MachineIndex<S, E, GD, EFD, R> => {
  let index = indexCache.get(machine) as MachineIndex<S, E, GD, EFD, R> | undefined;
  if (index === undefined) {
    index = {
      transitions: buildTransitionIndex(machine.transitions),
      always: buildAlwaysIndex(machine.alwaysTransitions),
      onEnter: buildEffectIndex(machine.onEnterEffects),
      onExit: buildEffectIndex(machine.onExitEffects),
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
  machine: Machine<S, E, R, never, any, any, GD, EFD>,
  stateTag: string,
  eventTag: string,
): ReadonlyArray<Transition<S, E, GD, EFD, R>> => {
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
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, never, any, any, GD, EFD>,
  stateTag: string,
): ReadonlyArray<AlwaysTransition<S, GD, EFD, R>> => {
  const index = getIndex(machine);
  return index.always.get(stateTag) ?? [];
};

/**
 * Find all onEnter effects for a state.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
export const findOnEnterEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, never, any, any, GD, EFD>,
  stateTag: string,
): ReadonlyArray<StateEffect<S, E, EFD, R>> => {
  const index = getIndex(machine);
  return index.onEnter.get(stateTag) ?? [];
};

/**
 * Find all onExit effects for a state.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
export const findOnExitEffects = <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, never, any, any, GD, EFD>,
  stateTag: string,
): ReadonlyArray<StateEffect<S, E, EFD, R>> => {
  const index = getIndex(machine);
  return index.onExit.get(stateTag) ?? [];
};
