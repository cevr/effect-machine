/**
 * Transition index for O(1) lookup by state/event tag.
 *
 * Uses a WeakMap cache to avoid memory leaks - machine references
 * can be garbage collected normally.
 *
 * @internal
 */
import type { Machine, Transition, SpawnEffect } from "../machine.js";
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
 * Build effect index from machine definition.
 */
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
