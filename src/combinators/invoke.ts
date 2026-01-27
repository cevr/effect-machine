import type { AnySlot, EffectSlotType, Machine } from "../machine.js";
import { addEffectSlot } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent } from "../internal/brands.js";

/** Helper to add multiple invoke slots with same stateTag */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const addMultipleInvokeSlots =
  (names: readonly string[], stateTag: string | null) => (builder: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any = builder;
    for (const name of names) {
      result = addEffectSlot({ type: "invoke", stateTag, name })(result);
    }
    return result;
  };

/** Type-level invoke slot */
type InvokeSlot<Name extends string> = EffectSlotType<"invoke", Name>;
type InvokeSlots<Names extends readonly string[]> = Names[number] extends infer Name
  ? Name extends string
    ? InvokeSlot<Name>
    : never
  : never;

// ============================================================================
// Overload 1: State + single name (existing API)
// ============================================================================

/**
 * Register a named invoke slot for a state.
 * The actual effect handler is provided via `Machine.provide`.
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   Machine.on(State.Idle, Event.Fetch, ({ event }) => State.Loading({ url: event.url })),
 *   Machine.on(State.Loading, Event.Resolve, ({ event }) => State.Success({ data: event.data })),
 *   Machine.invoke(State.Loading, "fetchData"),
 * )
 *
 * // Then provide the implementation:
 * const machineLive = Machine.provide(machine, {
 *   fetchData: ({ state, self }) =>
 *     Effect.gen(function* () {
 *       const http = yield* HttpClient
 *       const data = yield* http.get(state.url)
 *       yield* self.send(Event.Resolve({ data }))
 *     }),
 * })
 * ```
 */
export function invoke<NarrowedState extends BrandedState, Name extends string>(
  stateConstructor: { (...args: never[]): NarrowedState },
  name: Name,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R, Slots | InvokeSlot<Name>>;

// ============================================================================
// Overload 2: State + array of names (parallel invokes)
// ============================================================================

/**
 * Register multiple parallel invoke slots for a state.
 * All invokes start on state entry, all are interrupted on state exit.
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   Machine.invoke(State.InUse, ["onCashMachineEvent", "waitForStatus"]),
 * )
 *
 * const machineLive = Machine.provide(machine, {
 *   onCashMachineEvent: ({ self }) => Effect.forever(listenForEvents(self)),
 *   waitForStatus: ({ self }) => Effect.forever(pollStatus(self)),
 * })
 * ```
 */
export function invoke<NarrowedState extends BrandedState, const Names extends readonly string[]>(
  stateConstructor: { (...args: never[]): NarrowedState },
  names: Names,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R, Slots | InvokeSlots<Names>>;

// ============================================================================
// Overload 3: Root-level invoke (no state, runs for machine lifetime)
// ============================================================================

/**
 * Register a root-level invoke slot that runs for the machine's entire lifetime.
 * Starts on actor spawn, interrupted on actor stop.
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   Machine.invoke("stormNavigator"),
 * )
 *
 * const machineLive = Machine.provide(machine, {
 *   stormNavigator: ({ self }) =>
 *     Effect.forever(
 *       Effect.gen(function* () {
 *         const event = yield* subscribeToNavEvents
 *         yield* self.send(Event.Navigate(event))
 *       })
 *     ),
 * })
 * ```
 */
export function invoke<Name extends string>(
  name: Name,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R, Slots | InvokeSlot<Name>>;

// ============================================================================
// Overload 4: Root-level array of names (parallel root invokes)
// ============================================================================

/**
 * Register multiple root-level invoke slots that run for the machine's entire lifetime.
 * All start on actor spawn, all interrupted on actor stop.
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   Machine.invoke(["eventListener", "healthCheck"]),
 * )
 *
 * const machineLive = Machine.provide(machine, {
 *   eventListener: ({ self }) => Effect.forever(listenForEvents(self)),
 *   healthCheck: ({ self }) => Effect.forever(checkHealth(self)),
 * })
 * ```
 */
export function invoke<const Names extends readonly string[]>(
  names: Names,
): <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
  builder: Machine<State, Event, R, Slots>,
) => Machine<State, Event, R, Slots | InvokeSlots<Names>>;

// ============================================================================
// Implementation
// ============================================================================

export function invoke(
  stateConstructorOrName: unknown,
  nameOrNames?: string | readonly string[],
): unknown {
  // Root-level invoke: invoke("name")
  if (typeof stateConstructorOrName === "string") {
    const name = stateConstructorOrName;
    return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
      builder: Machine<State, Event, R, Slots>,
    ): Machine<State, Event, R, Slots | InvokeSlot<typeof name>> => {
      return addEffectSlot<State, Event, R, InvokeSlot<typeof name>>({
        type: "invoke",
        stateTag: null,
        name,
      })(builder);
    };
  }

  // Root-level array: invoke(["a", "b"])
  if (Array.isArray(stateConstructorOrName)) {
    return addMultipleInvokeSlots(stateConstructorOrName as string[], null);
  }

  // State constructor case
  const stateConstructor = stateConstructorOrName as { (...args: never[]): BrandedState };
  const stateTag = getTag(stateConstructor);

  // Array of names: invoke(State.X, ["a", "b"])
  if (Array.isArray(nameOrNames)) {
    return addMultipleInvokeSlots(nameOrNames as string[], stateTag);
  }

  // Single name: invoke(State.X, "name")
  const name = nameOrNames as string;
  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R, Slots | InvokeSlot<typeof name>> => {
    return addEffectSlot<State, Event, R, InvokeSlot<typeof name>>({
      type: "invoke",
      stateTag,
      name,
    })(builder);
  };
}
