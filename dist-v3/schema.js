import { InvalidSchemaError, MissingMatchHandlerError } from "./errors.js";
import { Schema } from "effect";

//#region src-v3/schema.ts
/**
 * Schema-first State/Event definitions for effect-machine.
 *
 * MachineSchema provides a single source of truth that combines:
 * - Schema for validation/serialization
 * - Variant constructors (like Data.taggedEnum)
 * - $is and $match helpers for pattern matching
 * - Brand integration for compile-time safety
 *
 * @example
 * ```ts
 * import { State, Event, Machine } from "effect-machine"
 *
 * // Define schema-first state
 * const OrderState = State({
 *   Pending: { orderId: Schema.String },
 *   Shipped: { trackingId: Schema.String },
 * })
 *
 * // Infer type from schema
 * type OrderState = typeof OrderState.Type
 *
 * // Use constructors
 * const pending = OrderState.Pending({ orderId: "123" })
 *
 * // Pattern match
 * OrderState.$match(state, {
 *   Pending: (s) => `Order ${s.orderId} pending`,
 *   Shipped: (s) => `Shipped: ${s.trackingId}`,
 * })
 *
 * // Use as Schema for persistence/cluster
 * machine.pipe(Machine.persist({ stateSchema: OrderState, ... }))
 * ```
 *
 * @module
 */
/**
 * Build a schema-first definition from a record of tag -> fields
 */
const buildMachineSchema = (definition) => {
  const variants = {};
  const constructors = {};
  for (const tag of Object.keys(definition)) {
    const fields = definition[tag];
    if (fields === void 0) continue;
    variants[tag] = Schema.TaggedStruct(tag, fields);
    const fieldNames = new Set(Object.keys(fields));
    if (fieldNames.size > 0) {
      const constructor = (args) => ({
        ...args,
        _tag: tag,
      });
      constructor._tag = tag;
      constructor.derive = (source, partial) => {
        const result = { _tag: tag };
        for (const key of fieldNames) if (key in source) result[key] = source[key];
        if (partial !== void 0)
          for (const [key, value] of Object.entries(partial)) result[key] = value;
        return result;
      };
      constructors[tag] = constructor;
    } else
      constructors[tag] = {
        _tag: tag,
        derive: () => ({ _tag: tag }),
      };
  }
  const variantArray = Object.values(variants);
  if (variantArray.length === 0) throw new InvalidSchemaError();
  const unionSchema = variantArray.length === 1 ? variantArray[0] : Schema.Union(...variantArray);
  const $is = (tag) => (u) => typeof u === "object" && u !== null && "_tag" in u && u._tag === tag;
  const $match = (valueOrCases, maybeCases) => {
    if (maybeCases !== void 0) {
      const value = valueOrCases;
      const handler = maybeCases[value._tag];
      if (handler === void 0) throw new MissingMatchHandlerError({ tag: value._tag });
      return handler(value);
    }
    const cases = valueOrCases;
    return (value) => {
      const handler = cases[value._tag];
      if (handler === void 0) throw new MissingMatchHandlerError({ tag: value._tag });
      return handler(value);
    };
  };
  return {
    schema: unionSchema,
    variants,
    constructors,
    _definition: definition,
    $is,
    $match,
  };
};
/**
 * Internal helper to create a machine schema (shared by State and Event).
 * Builds the schema object with variants, constructors, $is, and $match.
 */
const createMachineSchema = (definition) => {
  const { schema, variants, constructors, _definition, $is, $match } =
    buildMachineSchema(definition);
  return Object.assign(Object.create(schema), {
    variants,
    _definition,
    $is,
    $match,
    ...constructors,
  });
};
/**
 * Create a schema-first State definition.
 *
 * The schema's definition type D creates a unique brand, preventing
 * accidental use of constructors from different state schemas
 * (unless they have identical definitions).
 *
 * @example
 * ```ts
 * const OrderState = MachineSchema.State({
 *   Pending: { orderId: Schema.String },
 *   Shipped: { trackingId: Schema.String },
 * })
 *
 * type OrderState = typeof OrderState.Type
 *
 * // Construct
 * const s = OrderState.Pending({ orderId: "123" })
 *
 * // Pattern match
 * OrderState.$match(s, {
 *   Pending: (v) => v.orderId,
 *   Shipped: (v) => v.trackingId,
 * })
 *
 * // Validate
 * Schema.decodeUnknownSync(OrderState)(rawJson)
 * ```
 */
const State = (definition) => createMachineSchema(definition);
/**
 * Create a schema-first Event definition.
 *
 * The schema's definition type D creates a unique brand, preventing
 * accidental use of constructors from different event schemas
 * (unless they have identical definitions).
 *
 * @example
 * ```ts
 * const OrderEvent = MachineSchema.Event({
 *   Ship: { trackingId: Schema.String },
 *   Cancel: {},
 * })
 *
 * type OrderEvent = typeof OrderEvent.Type
 *
 * // Construct
 * const e = OrderEvent.Ship({ trackingId: "abc" })
 * ```
 */
const Event = (definition) => createMachineSchema(definition);

//#endregion
export { Event, State };
