// eslint-disable-next-line eslint-plugin-import/namespace -- false positive: Brand is a type namespace in effect
import type { Brand } from "effect";

// Unique symbols for type-level branding
declare const StateTypeId: unique symbol;
declare const EventTypeId: unique symbol;

export type StateTypeId = typeof StateTypeId;
export type EventTypeId = typeof EventTypeId;

// Brand interfaces - eslint-disable-next-line comments for false positive namespace warnings
// eslint-disable-next-line import/namespace
export interface StateBrand extends Brand.Brand<StateTypeId> {}
// eslint-disable-next-line import/namespace
export interface EventBrand extends Brand.Brand<EventTypeId> {}

// Shared branded type constraints used across all combinators
export type BrandedState = { readonly _tag: string } & StateBrand;
export type BrandedEvent = { readonly _tag: string } & EventBrand;

/**
 * Value or constructor for a tagged type.
 * Accepts both plain values (empty structs) and constructor functions (non-empty structs).
 */
export type TaggedOrConstructor<T extends { readonly _tag: string }> =
  | T
  | ((...args: never[]) => T);
