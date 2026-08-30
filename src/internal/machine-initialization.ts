/** How a machine creates the initial state for one actor. */
export type MachineInitialization<Input, State> =
  | { readonly _tag: "Static"; readonly state: State }
  | { readonly _tag: "Input"; readonly initialize: (input: Input) => State };

const make = <Input, State>(
  initial: State | ((input: Input) => State),
): MachineInitialization<Input, State> => {
  // eslint-disable-next-line effect/noRuntimeTypeof -- Machine.make accepts a state or initializer function
  if (typeof initial === "function") {
    return {
      _tag: "Input",
      // eslint-disable-next-line effect/noAs -- function values are the input initializer branch
      initialize: initial as (input: Input) => State,
    };
  }
  return { _tag: "Static", state: initial };
};

/** Resolve one actor initial state. This is the only input erasure seam. */
const resolve = <Input, State>(
  initialization: MachineInitialization<Input, State>,
  // eslint-disable-next-line effect/noUnknownParameters -- this module is the single conditional-input erasure seam
  input: unknown,
): State => {
  if (initialization._tag === "Static") return initialization.state;
  // eslint-disable-next-line effect/noAs -- public conditional options validate input before this seam
  return initialization.initialize(input as Input);
};

/** Return the static value, or undefined for an input machine. */
const staticValue = <Input, State>(
  initialization: MachineInitialization<Input, State>,
): State | undefined => {
  if (initialization._tag === "Static") return initialization.state;
  return undefined;
};

export const MachineInitialization = { make, resolve, staticValue };
