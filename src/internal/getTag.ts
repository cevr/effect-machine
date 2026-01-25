/**
 * Extract _tag from a Data.taggedEnum constructor
 * Supports both zero-arg and single-arg constructors
 */
export const getTag = (constructor: (...args: never[]) => { _tag: string }): string => {
  try {
    // Try zero-arg first (for unit-like constructors)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = (constructor as any)();
    return instance._tag;
  } catch {
    // Fall back to empty object arg (for record constructors)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instance = (constructor as any)({});
    return instance._tag;
  }
};
