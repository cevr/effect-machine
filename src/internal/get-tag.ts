/**
 * Extract _tag from a tagged value or constructor.
 *
 * Supports:
 * - Plain values with `_tag` (MachineSchema empty structs)
 * - Constructors with static `_tag` (MachineSchema non-empty structs)
 * - Data.taggedEnum constructors (fallback via instantiation)
 */
export const getTag = (
  constructorOrValue: { _tag: string } | ((...args: never[]) => { _tag: string }),
): string => {
  // Direct _tag property (values or static on constructors)
  if ("_tag" in constructorOrValue && typeof constructorOrValue._tag === "string") {
    return constructorOrValue._tag;
  }
  // Fallback: instantiate (Data.taggedEnum compatibility)
  // Try zero-arg first, then empty object for record constructors
  try {
    return (constructorOrValue as () => { _tag: string })()._tag;
  } catch {
    return (constructorOrValue as (args: object) => { _tag: string })({})._tag;
  }
};
