import { getTag } from "../internal/get-tag.js";
import type { BrandedState } from "../internal/brands.js";

/**
 * A matcher for multiple states - use with `on` to handle an event in multiple states
 */
export interface StateMatcher<_State> {
  readonly _tag: "StateMatcher";
  readonly stateTags: ReadonlyArray<string>;
}

type StateConstructor<S extends { readonly _tag: string }> = { (...args: never[]): S };

/**
 * Extract return type from constructor
 */
type StateOf<C> = C extends StateConstructor<infer S> ? S : never;

/**
 * Match multiple states for a single transition handler.
 * Use with `on` to handle the same event identically across multiple states.
 *
 * @example
 * ```ts
 * Machine.make<State, Event>(State.Idle({})).pipe(
 *   Machine.on(
 *     Machine.any(State.SelectingMethod, State.ProcessingPayment, State.PaymentError),
 *     Event.Cancel,
 *     () => State.Cancelled({})
 *   ),
 * )
 * ```
 */
export function any<
  C1 extends StateConstructor<BrandedState>,
  C2 extends StateConstructor<BrandedState>,
>(c1: C1, c2: C2): StateMatcher<StateOf<C1> | StateOf<C2>>;

export function any<
  C1 extends StateConstructor<BrandedState>,
  C2 extends StateConstructor<BrandedState>,
  C3 extends StateConstructor<BrandedState>,
>(c1: C1, c2: C2, c3: C3): StateMatcher<StateOf<C1> | StateOf<C2> | StateOf<C3>>;

export function any<
  C1 extends StateConstructor<BrandedState>,
  C2 extends StateConstructor<BrandedState>,
  C3 extends StateConstructor<BrandedState>,
  C4 extends StateConstructor<BrandedState>,
>(
  c1: C1,
  c2: C2,
  c3: C3,
  c4: C4,
): StateMatcher<StateOf<C1> | StateOf<C2> | StateOf<C3> | StateOf<C4>>;

export function any<
  C1 extends StateConstructor<BrandedState>,
  C2 extends StateConstructor<BrandedState>,
  C3 extends StateConstructor<BrandedState>,
  C4 extends StateConstructor<BrandedState>,
  C5 extends StateConstructor<BrandedState>,
>(
  c1: C1,
  c2: C2,
  c3: C3,
  c4: C4,
  c5: C5,
): StateMatcher<StateOf<C1> | StateOf<C2> | StateOf<C3> | StateOf<C4> | StateOf<C5>>;

export function any<
  C1 extends StateConstructor<BrandedState>,
  C2 extends StateConstructor<BrandedState>,
  C3 extends StateConstructor<BrandedState>,
  C4 extends StateConstructor<BrandedState>,
  C5 extends StateConstructor<BrandedState>,
  C6 extends StateConstructor<BrandedState>,
>(
  c1: C1,
  c2: C2,
  c3: C3,
  c4: C4,
  c5: C5,
  c6: C6,
): StateMatcher<StateOf<C1> | StateOf<C2> | StateOf<C3> | StateOf<C4> | StateOf<C5> | StateOf<C6>>;

// Fallback for more than 6 states
export function any<NarrowedState extends BrandedState>(
  ...stateConstructors: Array<StateConstructor<NarrowedState>>
): StateMatcher<NarrowedState>;

export function any(
  ...stateConstructors: Array<StateConstructor<BrandedState>>
): StateMatcher<BrandedState> {
  return {
    _tag: "StateMatcher",
    stateTags: stateConstructors.map(getTag),
  };
}

/**
 * Check if a value is a StateMatcher
 */
export const isStateMatcher = <S>(value: unknown): value is StateMatcher<S> =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  (value as { _tag: unknown })._tag === "StateMatcher";
