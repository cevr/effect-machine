import type { Fiber } from "effect";
import type { MachineRef } from "../machine.js";

/**
 * Create per-actor fiber storage for managing concurrent fibers.
 * Uses WeakMap for automatic cleanup when actor refs are GC'd.
 *
 * @internal
 */
export const createFiberStorage = () => {
  const storage = new WeakMap<MachineRef<unknown>, Map<symbol, Fiber.RuntimeFiber<void, never>>>();

  return <E>(self: MachineRef<E>): Map<symbol, Fiber.RuntimeFiber<void, never>> => {
    const key = self as MachineRef<unknown>;
    let map = storage.get(key);
    if (map === undefined) {
      map = new Map();
      storage.set(key, map);
    }
    return map;
  };
};
