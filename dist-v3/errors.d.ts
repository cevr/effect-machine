//#region src-v3/errors.d.ts
declare const DuplicateActorError_base: any;
/** Attempted to spawn/restore actor with ID already in use */
declare class DuplicateActorError extends DuplicateActorError_base {}
declare const UnprovidedSlotsError_base: any;
/** Machine has unprovided effect slots */
declare class UnprovidedSlotsError extends UnprovidedSlotsError_base {}
declare const MissingSchemaError_base: any;
/** Operation requires schemas attached to machine */
declare class MissingSchemaError extends MissingSchemaError_base {}
declare const InvalidSchemaError_base: any;
/** State/Event schema has no variants */
declare class InvalidSchemaError extends InvalidSchemaError_base {}
declare const MissingMatchHandlerError_base: any;
/** $match called with missing handler for tag */
declare class MissingMatchHandlerError extends MissingMatchHandlerError_base {}
declare const SlotProvisionError_base: any;
/** Slot handler not found at runtime (internal error) */
declare class SlotProvisionError extends SlotProvisionError_base {}
declare const ProvisionValidationError_base: any;
/** Machine.build() validation failed - missing or extra handlers */
declare class ProvisionValidationError extends ProvisionValidationError_base {}
declare const AssertionError_base: any;
/** Assertion failed in testing utilities */
declare class AssertionError extends AssertionError_base {}
//#endregion
export {
  AssertionError,
  DuplicateActorError,
  InvalidSchemaError,
  MissingMatchHandlerError,
  MissingSchemaError,
  ProvisionValidationError,
  SlotProvisionError,
  UnprovidedSlotsError,
};
