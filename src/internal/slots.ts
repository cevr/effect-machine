/**
 * Slot validation — boundary check for guard/effect handler provisioning.
 *
 * @internal
 */
import { ProvisionValidationError } from "../errors.js";

/**
 * Validate slot handlers and return a handler map.
 * If no handlers provided and machine has no slots, returns undefined.
 * Validates that all required slots are provided and no extra slots are given.
 *
 * The returned Map is threaded through MachineContext._slotHandlers at runtime.
 * The machine itself is never copied or mutated.
 *
 * @internal — used by spawn, replay, simulate, test harness, entity-machine
 */
export const validateSlots = (
  machine: {
    readonly _guardsSchema?: { readonly definitions: Record<string, unknown> };
    readonly _effectsSchema?: { readonly definitions: Record<string, unknown> };
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers?: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ReadonlyMap<string, any> | undefined => {
  if (handlers === undefined) {
    const hasGuards =
      machine._guardsSchema !== undefined &&
      Object.keys(machine._guardsSchema.definitions).length > 0;
    const hasEffects =
      machine._effectsSchema !== undefined &&
      Object.keys(machine._effectsSchema.definitions).length > 0;
    if (hasGuards || hasEffects) {
      const missing: string[] = [];
      if (machine._guardsSchema !== undefined) {
        missing.push(...Object.keys(machine._guardsSchema.definitions));
      }
      if (machine._effectsSchema !== undefined) {
        missing.push(...Object.keys(machine._effectsSchema.definitions));
      }
      throw new ProvisionValidationError({ missing, extra: [] });
    }
    return undefined;
  }

  const requiredSlots = new Set<string>();
  if (machine._guardsSchema !== undefined) {
    for (const name of Object.keys(machine._guardsSchema.definitions)) {
      requiredSlots.add(name);
    }
  }
  if (machine._effectsSchema !== undefined) {
    for (const name of Object.keys(machine._effectsSchema.definitions)) {
      requiredSlots.add(name);
    }
  }

  const providedSlots = new Set(Object.keys(handlers));
  const missing: string[] = [];
  const extra: string[] = [];

  for (const name of requiredSlots) {
    if (!providedSlots.has(name)) {
      missing.push(name);
    }
  }
  for (const name of providedSlots) {
    if (!requiredSlots.has(name)) {
      extra.push(name);
    }
  }

  if (missing.length > 0 || extra.length > 0) {
    throw new ProvisionValidationError({ missing, extra });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlerMap = new Map<string, any>();
  for (const [name, handler] of Object.entries(handlers)) {
    handlerMap.set(name, handler);
  }
  return handlerMap;
};
