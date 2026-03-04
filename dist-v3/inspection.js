import { Context } from "effect";

//#region src-v3/inspection.ts
/**
 * Inspector service tag - optional service for machine introspection
 * Uses `any` types to allow variance flexibility when providing the service
 */
const Inspector = Context.GenericTag("@effect/machine/Inspector");
/**
 * Create an inspector from a callback function.
 *
 * Type params accept either raw tagged types or Schema constructors:
 * - `makeInspector(cb)` — defaults to `AnyInspectionEvent`
 * - `makeInspector<MyState, MyEvent>(cb)` — explicit tagged types
 * - `makeInspector<typeof MyState, typeof MyEvent>(cb)` — schema constructors (auto-extracts `.Type`)
 */
const makeInspector = (onInspect) => ({ onInspect });
/**
 * Console inspector that logs events in a readable format
 */
const consoleInspector = () =>
  makeInspector((event) => {
    const prefix = `[${event.actorId}]`;
    switch (event.type) {
      case "@machine.spawn":
        console.log(prefix, "spawned →", event.initialState._tag);
        break;
      case "@machine.event":
        console.log(prefix, "received", event.event._tag, "in", event.state._tag);
        break;
      case "@machine.transition":
        console.log(prefix, event.fromState._tag, "→", event.toState._tag);
        break;
      case "@machine.effect":
        console.log(prefix, event.effectType, "effect in", event.state._tag);
        break;
      case "@machine.error":
        console.log(prefix, "error in", event.phase, event.state._tag, "-", event.error);
        break;
      case "@machine.stop":
        console.log(prefix, "stopped in", event.finalState._tag);
        break;
    }
  });
/**
 * Collecting inspector that stores events in an array for testing
 */
const collectingInspector = (events) => ({ onInspect: (event) => events.push(event) });

//#endregion
export { Inspector, collectingInspector, consoleInspector, makeInspector };
