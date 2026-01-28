import { Effect } from "effect";

/** Check if a value is an Effect */
export const isEffect = (value: unknown): value is Effect.Effect<unknown, unknown, unknown> =>
  typeof value === "object" && value !== null && Effect.EffectTypeId in value;
