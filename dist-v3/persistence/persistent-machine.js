import { MissingSchemaError } from "../errors.js";
//#region src-v3/persistence/persistent-machine.ts
/**
 * Type guard to check if a value is a PersistentMachine
 */
const isPersistentMachine = (value) =>
  typeof value === "object" &&
  value !== null &&
  "_tag" in value &&
  value._tag === "PersistentMachine";
const persist = (config) => (machine) => {
  const stateSchema = machine.stateSchema;
  const eventSchema = machine.eventSchema;
  if (stateSchema === void 0 || eventSchema === void 0)
    throw new MissingSchemaError({ operation: "persist" });
  return {
    _tag: "PersistentMachine",
    machine,
    persistence: {
      ...config,
      stateSchema,
      eventSchema,
    },
  };
};
//#endregion
export { isPersistentMachine, persist };
