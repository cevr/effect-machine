import { Brand } from "effect";

//#region src-v3/internal/brands.d.ts
declare const StateTypeId: unique symbol;
declare const EventTypeId: unique symbol;
type StateTypeId = typeof StateTypeId;
type EventTypeId = typeof EventTypeId;
interface StateBrand extends Brand.Brand<StateTypeId> {}
interface EventBrand extends Brand.Brand<EventTypeId> {}
type BrandedState = {
  readonly _tag: string;
} & StateBrand;
type BrandedEvent = {
  readonly _tag: string;
} & EventBrand;
declare const SchemaIdTypeId: unique symbol;
type SchemaIdTypeId = typeof SchemaIdTypeId;
/**
 * Brand that captures the schema definition type D.
 * Two schemas with identical definition shapes will have compatible brands.
 * Different definitions = incompatible brands.
 */
interface SchemaIdBrand<_D extends Record<string, unknown>> extends Brand.Brand<SchemaIdTypeId> {}
/**
 * Full state brand: combines base state brand with schema-specific brand
 */
type FullStateBrand<D extends Record<string, unknown>> = StateBrand & SchemaIdBrand<D>;
/**
 * Full event brand: combines base event brand with schema-specific brand
 */
type FullEventBrand<D extends Record<string, unknown>> = EventBrand & SchemaIdBrand<D>;
/**
 * Value or constructor for a tagged type.
 * Accepts both plain values (empty structs) and constructor functions (non-empty structs).
 */
type TaggedOrConstructor<
  T extends {
    readonly _tag: string;
  },
> = T | ((...args: never[]) => T);
//#endregion
export {
  BrandedEvent,
  BrandedState,
  EventBrand,
  EventTypeId,
  FullEventBrand,
  FullStateBrand,
  SchemaIdBrand,
  StateBrand,
  StateTypeId,
  TaggedOrConstructor,
};
