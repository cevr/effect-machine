import { FullEventBrand, FullStateBrand } from "./internal/brands.js";
import { Schema } from "effect";

//#region src-v3/schema.d.ts
/**
 * Extract the TypeScript type from a TaggedStruct schema
 */
type TaggedStructType<Tag extends string, Fields extends Schema.Struct.Fields> = Schema.Schema.Type<
  Schema.TaggedStruct<Tag, Fields>
>;
/**
 * Build variant schemas type from definition
 */
type VariantSchemas<D extends Record<string, Schema.Struct.Fields>> = {
  readonly [K in keyof D & string]: Schema.TaggedStruct<K, D[K]>;
};
/**
 * Build union type from variant schemas.
 * Used for constraining fluent method type params.
 */
type VariantsUnion<D extends Record<string, Schema.Struct.Fields>> = {
  [K in keyof D & string]: TaggedStructType<K, D[K]>;
}[keyof D & string];
/**
 * Check if fields are empty (no required properties)
 */
type IsEmptyFields<Fields extends Schema.Struct.Fields> = keyof Fields extends never ? true : false;
/**
 * Constructor functions for each variant.
 * Empty structs: plain values with `_tag`: `State.Idle`
 * Non-empty structs require args: `State.Loading({ url })`
 *
 * Each variant also has a `derive` method for constructing from a source object.
 */
/**
 * Constructor functions for each variant.
 * Empty structs: plain values with `_tag`: `State.Idle`
 * Non-empty structs require args: `State.Loading({ url })`
 *
 * Each variant also has a `derive` method for constructing from a source object.
 * The source type uses `object` to accept branded state types without index signature issues.
 */
type VariantConstructors<D extends Record<string, Schema.Struct.Fields>, Brand> = {
  readonly [K in keyof D & string]: IsEmptyFields<D[K]> extends true
    ? TaggedStructType<K, D[K]> &
        Brand & {
          readonly derive: (source: object) => TaggedStructType<K, D[K]> & Brand;
        }
    : ((args: Schema.Struct.Constructor<D[K]>) => TaggedStructType<K, D[K]> & Brand) & {
        readonly derive: (
          source: object,
          partial?: Partial<Schema.Struct.Constructor<D[K]>>,
        ) => TaggedStructType<K, D[K]> & Brand;
        readonly _tag: K;
      };
};
/**
 * Pattern matching cases type
 */
type MatchCases<D extends Record<string, Schema.Struct.Fields>, R> = {
  readonly [K in keyof D & string]: (value: TaggedStructType<K, D[K]>) => R;
};
/**
 * Base schema interface with pattern matching helpers
 */
interface MachineSchemaBase<D extends Record<string, Schema.Struct.Fields>, Brand> {
  /**
   * Raw definition record for introspection
   */
  readonly _definition: D;
  /**
   * Per-variant schemas for fine-grained operations
   */
  readonly variants: VariantSchemas<D>;
  /**
   * Type guard: `OrderState.$is("Pending")(value)`
   */
  readonly $is: <Tag extends keyof D & string>(
    tag: Tag,
  ) => (u: unknown) => u is TaggedStructType<Tag, D[Tag]> & Brand;
  /**
   * Pattern matching (curried and uncurried)
   */
  readonly $match: {
    <R>(cases: MatchCases<D, R>): (value: VariantsUnion<D> & Brand) => R;
    <R>(value: VariantsUnion<D> & Brand, cases: MatchCases<D, R>): R;
  };
}
/**
 * Schema-first state definition that provides:
 * - Schema for encode/decode/validate
 * - Variant constructors: `OrderState.Pending({ orderId: "x" })`
 * - Pattern matching: `$is`, `$match`
 * - Type inference: `typeof OrderState.Type`
 *
 * The D type parameter captures the definition, creating a unique brand
 * per distinct schema definition shape.
 */
type MachineStateSchema<D extends Record<string, Schema.Struct.Fields>> = Schema.Schema<
  VariantsUnion<D> & FullStateBrand<D>,
  VariantsUnion<D>,
  never
> &
  MachineSchemaBase<D, FullStateBrand<D>> &
  VariantConstructors<D, FullStateBrand<D>>;
/**
 * Schema-first event definition (same structure as state, different brand)
 *
 * The D type parameter captures the definition, creating a unique brand
 * per distinct schema definition shape.
 */
type MachineEventSchema<D extends Record<string, Schema.Struct.Fields>> = Schema.Schema<
  VariantsUnion<D> & FullEventBrand<D>,
  VariantsUnion<D>,
  never
> &
  MachineSchemaBase<D, FullEventBrand<D>> &
  VariantConstructors<D, FullEventBrand<D>>;
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
declare const State: <const D extends Record<string, Schema.Struct.Fields>>(
  definition: D,
) => MachineStateSchema<D>;
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
declare const Event: <const D extends Record<string, Schema.Struct.Fields>>(
  definition: D,
) => MachineEventSchema<D>;
//#endregion
export { Event, MachineEventSchema, MachineStateSchema, State, VariantsUnion };
