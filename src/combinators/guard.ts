import type { AnySlot, EffectSlotType, Machine } from "../machine.js";
import { addEffectSlot } from "../machine.js";
import { getTag } from "../internal/get-tag.js";
import type { BrandedState, BrandedEvent, TaggedOrConstructor } from "../internal/brands.js";

/** Type-level guard slot */
type GuardSlot<Name extends string> = EffectSlotType<"guard", Name>;

/**
 * Register a named guard slot for a state/event combination.
 * The actual guard implementation (Effect<boolean>) is provided via `Machine.provide`.
 *
 * Named guards can be:
 * - Referenced by name in `on()` transitions: `{ guard: "canPrint" }`
 * - Composed with Guard.and/or/not: `{ guard: Guard.and("canPrint", "hasPermission") }`
 * - Effectful (async, with service dependencies)
 *
 * @example
 * ```ts
 * const machine = Machine.make({ state, event, initial }).pipe(
 *   // Register named guard slots
 *   Machine.guard(State.Ready, Event.Print, "canPrint"),
 *   Machine.guard(State.Ready, Event.Print, "hasPermission"),
 *
 *   // Reference guards by name
 *   Machine.on(State.Ready, Event.Print, () => State.Printing, {
 *     guard: "canPrint"
 *   }),
 *
 *   // Compose guards
 *   Machine.on(State.Ready, Event.BatchPrint, () => State.BatchPrinting, {
 *     guard: Guard.and("canPrint", "hasPermission")
 *   }),
 * )
 *
 * // Provide guard implementations (Effect<boolean>)
 * const machineLive = Machine.provide(machine, {
 *   canPrint: ({ state }) => Effect.succeed(state.printerReady),
 *   hasPermission: ({ state }) =>
 *     Effect.gen(function* () {
 *       const auth = yield* AuthService
 *       return yield* auth.checkPermission(state.userId, "print")
 *     }),
 * })
 * ```
 */
export function guard<
  NarrowedState extends BrandedState,
  NarrowedEvent extends BrandedEvent,
  Name extends string,
>(
  state: TaggedOrConstructor<NarrowedState>,
  event: TaggedOrConstructor<NarrowedEvent>,
  name: Name,
) {
  const stateTag = getTag(state);
  const eventTag = getTag(event);

  return <State extends BrandedState, Event extends BrandedEvent, R, Slots extends AnySlot>(
    builder: Machine<State, Event, R, Slots>,
  ): Machine<State, Event, R, Slots | GuardSlot<Name>> => {
    return addEffectSlot<State, Event, R, GuardSlot<Name>>({
      type: "guard",
      stateTag,
      eventTag,
      name,
    })(builder);
  };
}
