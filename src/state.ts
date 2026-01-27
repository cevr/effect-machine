/**
 * Branded State types for type-safe state machine definitions.
 *
 * Use `State<T>` type and `State<T>()` constructor instead of `Data.TaggedEnum`
 * and `Data.taggedEnum()` to get compile-time safety preventing State/Event mixups.
 *
 * @example
 * ```ts
 * import { State } from "effect-machine"
 *
 * type MyState = State<{
 *   Idle: {};
 *   Active: { count: number };
 * }>
 * const MyState = State<MyState>()
 * ```
 *
 * @module
 */
import { Data } from "effect";
import type { Brand, Types } from "effect";
import type { StateBrand } from "./internal/brands.js";

// Internal helper to bypass Data.TaggedEnum's constraint check
type DataTaggedEnumUnchecked<A> = keyof A extends infer Tag
  ? Tag extends keyof A
    ? Types.Simplify<{ readonly _tag: Tag } & { readonly [K in keyof A[Tag]]: A[Tag][K] }>
    : never
  : never;

/**
 * Arguments for constructing a tagged enum variant.
 * Strips _tag and brand properties from the required input.
 */
type Args<A extends { readonly _tag: string }, K extends A["_tag"]> =
  Omit<Extract<A, { readonly _tag: K }>, "_tag" | typeof Brand.BrandTypeId> extends infer T
    ? {} extends T
      ? void
      : { readonly [P in keyof T]: T[P] }
    : never;

/**
 * Constructor type for branded tagged enums.
 * Input types don't require the brand (it's phantom).
 * Output types include the brand for type safety.
 */
type Constructor<A extends { readonly _tag: string }> = Types.Simplify<
  {
    readonly [Tag in A["_tag"]]: (args: Args<A, Tag>) => Extract<A, { readonly _tag: Tag }>;
  } & {
    readonly $is: <Tag extends A["_tag"]>(
      tag: Tag,
    ) => (u: unknown) => u is Extract<A, { readonly _tag: Tag }>;
    readonly $match: {
      <
        Cases extends {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match handlers can return any type
          readonly [Tag in A["_tag"]]: (args: Extract<A, { readonly _tag: Tag }>) => unknown;
        },
      >(
        cases: Cases,
      ): (value: A) => ReturnType<Cases[A["_tag"]]>;
      <
        Cases extends {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match handlers can return any type
          readonly [Tag in A["_tag"]]: (args: Extract<A, { readonly _tag: Tag }>) => unknown;
        },
      >(
        value: A,
        cases: Cases,
      ): ReturnType<Cases[A["_tag"]]>;
    };
  }
>;

/**
 * A tagged enum branded as a State type.
 * Prevents accidental use of State where Event is expected and vice versa.
 *
 * Note: The brand is phantom - it exists only at the type level.
 * Values created by the constructor are structurally identical to Data.TaggedEnum values.
 *
 * @example
 * ```ts
 * type MyState = State<{
 *   Idle: {};
 *   Active: { count: number };
 * }>
 * const MyState = State<MyState>()
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Record<string, any> mirrors Data.TaggedEnum constraint
export type State<A extends Record<string, Record<string, unknown>>> = DataTaggedEnumUnchecked<A> &
  StateBrand;

/**
 * Create a branded state tagged enum constructor.
 *
 * @example
 * ```ts
 * type MyState = State<{
 *   Idle: {};
 *   Active: { count: number };
 * }>
 * const MyState = State<MyState>()
 *
 * const idle = MyState.Idle({})       // typed as MyState
 * const active = MyState.Active({ count: 1 })
 * ```
 */
export const State = <A extends { readonly _tag: string } & StateBrand>(): Constructor<A> =>
  Data.taggedEnum() as Constructor<A>;

/**
 * Namespace for advanced State types.
 */
export namespace State {
  /**
   * Extract a specific variant from a branded State.
   */
  export type Value<A extends { readonly _tag: string }, K extends A["_tag"]> = Extract<
    A,
    { readonly _tag: K }
  >;

  /**
   * Constructor type for branded state tagged enums.
   */
  export type Constructor<A extends { readonly _tag: string }> = Types.Simplify<
    {
      readonly [Tag in A["_tag"]]: (args: Args<A, Tag>) => Extract<A, { readonly _tag: Tag }>;
    } & {
      readonly $is: <Tag extends A["_tag"]>(
        tag: Tag,
      ) => (u: unknown) => u is Extract<A, { readonly _tag: Tag }>;
      readonly $match: {
        <
          Cases extends {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match handlers can return any type
            readonly [Tag in A["_tag"]]: (args: Extract<A, { readonly _tag: Tag }>) => unknown;
          },
        >(
          cases: Cases,
        ): (value: A) => ReturnType<Cases[A["_tag"]]>;
        <
          Cases extends {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- match handlers can return any type
            readonly [Tag in A["_tag"]]: (args: Extract<A, { readonly _tag: Tag }>) => unknown;
          },
        >(
          value: A,
          cases: Cases,
        ): ReturnType<Cases[A["_tag"]]>;
      };
    }
  >;
}
