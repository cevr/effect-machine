/**
 * Slot validation — boundary check for guard/effect handler provisioning.
 *
 * @internal
 */
import { ProvisionValidationError } from "../errors.js";

/**
 * Validated slot handlers, separated by type to prevent namespace collisions.
 * Guards and effects may share names — this structure keeps them distinct.
 * @internal
 */
export interface SlotHandlers {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly guards: ReadonlyMap<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly effects: ReadonlyMap<string, any>;
}

/**
 * Validate slot handlers and return separated guard/effect maps.
 * If no handlers provided and machine has no slots, returns undefined.
 * Validates that all required slots are provided and no extra slots are given.
 *
 * The returned SlotHandlers is threaded through MachineContext._slotHandlers at runtime.
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
): SlotHandlers | undefined => {
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

  // Collect all required slot names
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

  // Single-pass validation
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

  // Build separate guard and effect maps to prevent namespace collisions
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const guardMap = new Map<string, any>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const effectMap = new Map<string, any>();

  if (machine._guardsSchema !== undefined) {
    for (const name of Object.keys(machine._guardsSchema.definitions)) {
      guardMap.set(name, handlers[name]);
    }
  }
  if (machine._effectsSchema !== undefined) {
    for (const name of Object.keys(machine._effectsSchema.definitions)) {
      effectMap.set(name, handlers[name]);
    }
  }

  return { guards: guardMap, effects: effectMap };
};
