import { Context } from "effect";
//#region src-v3/slot.ts
/**
 * Slot module - schema-based, parameterized guards and effects.
 *
 * Guards and Effects are defined with schemas for their parameters,
 * and provided implementations receive typed parameters plus machine context.
 *
 * @example
 * ```ts
 * import { Slot } from "effect-machine"
 * import { Schema } from "effect"
 *
 * const MyGuards = Slot.Guards({
 *   canRetry: { max: Schema.Number },
 *   isValid: {},  // no params
 * })
 *
 * const MyEffects = Slot.Effects({
 *   fetchData: { url: Schema.String },
 *   notify: { message: Schema.String },
 * })
 *
 * // Used in handlers:
 * .on(State.X, Event.Y, ({ guards, effects }) =>
 *   Effect.gen(function* () {
 *     if (yield* guards.canRetry({ max: 3 })) {
 *       yield* effects.fetchData({ url: "/api" })
 *       return State.Next
 *     }
 *     return state
 *   })
 * )
 * ```
 *
 * @module
 */
/**
 * Shared Context tag for all machines.
 * Single module-level tag instead of per-machine allocation.
 * @internal
 */
const MachineContextTag = Context.GenericTag("@effect-machine/Context");
/**
 * Generic slot schema factory. Used internally by Guards() and Effects().
 * @internal
 */
const createSlotSchema = (tag, slotTag, definitions) => ({
  _tag: tag,
  definitions,
  _createSlots: (resolve) => {
    const slots = {};
    for (const name of Object.keys(definitions)) {
      const slot = (params) => resolve(name, params);
      Object.defineProperty(slot, "_tag", {
        value: slotTag,
        enumerable: true,
      });
      Object.defineProperty(slot, "name", {
        value: name,
        enumerable: true,
      });
      slots[name] = slot;
    }
    return slots;
  },
});
/**
 * Create a guards schema with parameterized guard definitions.
 *
 * @example
 * ```ts
 * const MyGuards = Slot.Guards({
 *   canRetry: { max: Schema.Number },
 *   isValid: {},
 * })
 * ```
 */
const Guards = (definitions) => createSlotSchema("GuardsSchema", "GuardSlot", definitions);
/**
 * Create an effects schema with parameterized effect definitions.
 *
 * @example
 * ```ts
 * const MyEffects = Slot.Effects({
 *   fetchData: { url: Schema.String },
 *   notify: { message: Schema.String },
 * })
 * ```
 */
const Effects = (definitions) => createSlotSchema("EffectsSchema", "EffectSlot", definitions);
const Slot = {
  Guards,
  Effects,
};
//#endregion
export { Effects, Guards, MachineContextTag, Slot };
