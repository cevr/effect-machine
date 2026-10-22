/**
 * The cells of the type-level check of the `task` handler rule (issue #95).
 *
 * Rule: a `task` call compiles if and only if its options give `onSuccess`
 * unless the run's success type is assignable to the machine's event union,
 * and give `onFailure` unless the run's error type is assignable to `never`.
 * "Assignable" is TypeScript's relation at the call: a type parameter counts
 * through its constraint, and `any` is assignable to every type except
 * `never`. A handler is "given" only when the options type has the property
 * as required and its type excludes `undefined`.
 *
 * A cell is one `task` call with the rule's verdict. The generated cells cross
 * (each with every other):
 * - call form: one state or a list of states, at module level or in a generic helper;
 * - run form: plain, context-reading, `Effect.gen`;
 * - options container: inline literal, variable of a declared type, union of two option types;
 * - per handler: absent, or given / optional / `fn | undefined`, each with a parameter
 *   typed as the run's own type, `any`, `unknown`, or a wider supertype;
 * - success and error types (13 each).
 *
 * The default product is the union of two full products: every success and error type
 * with every other dimension (handler parameter = the run's own type), and every
 * handler parameter type with every other dimension on five success and five error
 * types. The full product crosses all dimensions. The fixed cells are every earlier
 * counterexample and review probe.
 */
// ---------------------------------------------------------------------------
// Domain
// ---------------------------------------------------------------------------

interface Kind {
  readonly name: string;
  /** Type parameter declaration at a generic helper site, if the kind is a type parameter. */
  readonly parameter: string | undefined;
  /** The type as the helper names it. */
  readonly type: string;
  /** The type at a concrete call site: a type parameter becomes its constraint. */
  readonly bound: string;
  /** The rule's verdict for this slot: assignable to the event union (success) or to never (error). */
  readonly free: boolean;
  readonly isAny: boolean;
}

const kind = (
  name: string,
  type: string,
  free: boolean,
  parameter?: { readonly name: string; readonly constraint: string | undefined },
): Kind => {
  if (parameter === undefined) {
    return { name, parameter: undefined, type, bound: type, free, isAny: type === "any" };
  }
  if (parameter.constraint === undefined) {
    return {
      name,
      parameter: parameter.name,
      type: parameter.name,
      bound: "unknown",
      free,
      isAny: false,
    };
  }
  return {
    name,
    parameter: `${parameter.name} extends ${parameter.constraint}`,
    type: parameter.name,
    bound: parameter.constraint,
    free,
    isAny: false,
  };
};

const A = (constraint?: string) => ({ name: "A", constraint });
const Err = (constraint?: string) => ({ name: "Err", constraint });

/** Success kinds; `free` = assignable to the event union, so no onSuccess is needed. */
const successKinds: ReadonlyArray<Kind> = [
  kind("event", "Done", true),
  kind("nonEvent", "number", false),
  kind("never", "never", true),
  kind("void", "void", false),
  kind("eventUnion", "Done | Failed", true),
  kind("mixedUnion", "Done | number", false),
  kind("any", "any", true),
  kind("param", "A", false, A()),
  kind("paramEvent", "A", true, A("Done")),
  kind("paramEventUnion", "A", true, A("Done | Failed")),
  kind("paramNonEvent", "A", false, A("number")),
  kind("paramNever", "A", true, A("never")),
  kind("paramMixed", "A", false, A("Done | number")),
];

/** Error kinds; `free` = assignable to never, so no onFailure is needed. */
const errorKinds: ReadonlyArray<Kind> = [
  kind("never", "never", true),
  kind("event", "Done", false),
  kind("nonEvent", "LoadError", false),
  kind("void", "void", false),
  kind("eventUnion", "Done | Failed", false),
  kind("mixedUnion", "Done | LoadError", false),
  kind("any", "any", false),
  kind("param", "Err", false, Err()),
  kind("paramEvent", "Err", false, Err("Done")),
  kind("paramEventUnion", "Err", false, Err("Done | Failed")),
  kind("paramNonEvent", "Err", false, Err("LoadError")),
  kind("paramNever", "Err", true, Err("never")),
  kind("paramMixed", "Err", false, Err("Done | LoadError")),
];

/**
 * The success and error kinds that the handler-parameter product crosses: a concrete
 * free and non-free type, `any`, and a free and non-free type parameter.
 */
const representativeSuccessNames: ReadonlySet<string> = new Set([
  "event",
  "nonEvent",
  "any",
  "param",
  "paramEvent",
]);
const representativeErrorNames: ReadonlySet<string> = new Set([
  "never",
  "nonEvent",
  "any",
  "param",
  "paramNever",
]);

/**
 * How the options give one handler:
 * - given: a required property with a function (the only slot that counts as given);
 * - optional: an optional property (inline: spread from a value of type `{ onX?: fn }`;
 *   union: present in one member only);
 * - maybe: a required property typed `fn | undefined`.
 */
type Slot = "given" | "optional" | "maybe";
/** The handler's parameter type: the run's own type, `any`, `unknown`, or the run's type widened. */
type ParameterForm = "run" | "any" | "unknown" | "wider";
type HandlerState =
  | { readonly slot: "absent" }
  | { readonly slot: Slot; readonly parameter: ParameterForm };

const slots: ReadonlyArray<Slot> = ["given", "optional", "maybe"];
const allParameterForms: ReadonlyArray<ParameterForm> = ["run", "any", "unknown", "wider"];

const handlerStates = (parameters: ReadonlyArray<ParameterForm>): ReadonlyArray<HandlerState> => [
  { slot: "absent" },
  ...slots.flatMap((slot) => parameters.map((parameter) => ({ slot, parameter }))),
];

const handlerStateName = (state: HandlerState): string => {
  if (state.slot === "absent") return "absent";
  return `${state.slot}-${state.parameter}`;
};

const parameterTypeByForm: Record<ParameterForm, (type: string) => string> = {
  run: (type) => type,
  any: () => "any",
  unknown: () => "unknown",
  wider: (type) => `${type} | bigint`,
};

/**
 * - inline: an object literal at the call;
 * - variable: an options value of a declared object type;
 * - union: an options value whose type is a union of two option objects.
 */
type Container = "inline" | "variable" | "union";
type StatesForm = "one" | "list";
type Site = "module" | "helper";
/** plain: `() => load("/")`; context: reads `state` (context-sensitive); gen: an Effect.gen run. */
type RunForm = "plain" | "context" | "gen";

const containers: ReadonlyArray<Container> = ["inline", "variable", "union"];
const statesForms: ReadonlyArray<StatesForm> = ["one", "list"];
const sites: ReadonlyArray<Site> = ["module", "helper"];
const runForms: ReadonlyArray<RunForm> = ["plain", "context", "gen"];

export interface Cell {
  readonly id: string;
  readonly code: string;
  readonly compiles: boolean;
  readonly group: string;
}

const handlerParameter = { onSuccess: "value", onFailure: "error" } as const;

const handlerType = (slot: "onSuccess" | "onFailure", type: string): string =>
  `(${handlerParameter[slot]}: ${type}) => Done`;

/** A lambda whose parameter must have exactly the kind's type (and not `any` unless the kind is any). */
const contextualLambda = (
  slot: "onSuccess" | "onFailure",
  slotKind: Kind,
  type: string,
  stateRead: string,
): string => {
  const parameter = handlerParameter[slot];
  const result = `E.Failed({ error: String(${parameter} satisfies ${type}) + ${stateRead} })`;
  if (slotKind.isAny) return `(${parameter}, { state }) => ${result}`;
  if (type !== slotKind.type || slotKind.parameter === undefined) {
    return `(${parameter}, { state }) => (notAny<typeof ${parameter}>(${parameter}), ${result})`;
  }
  // A type parameter keeps the conditional in notAny deferred, so the check is that the
  // parameter does not reach an unrelated unique type. A parameter bounded by never
  // reaches every type, so it gets only the satisfies check.
  if (slotKind.bound === "never") return `(${parameter}, { state }) => ${result}`;
  return `(${parameter}, { state }) => {
    // @ts-expect-error -- the parameter is the helper's type parameter, not any
    ${parameter} satisfies Marker;
    return ${result};
  }`;
};

/** A lambda with a written parameter type; the context parameter stays contextual. */
const annotatedLambda = (
  slot: "onSuccess" | "onFailure",
  type: string,
  stateRead: string,
): string => {
  const parameter = handlerParameter[slot];
  return `(${parameter}: ${type}, { state }) => E.Failed({ error: String(${parameter} satisfies ${type}) + ${stateRead} })`;
};

const nameEntry = {
  required: "readonly name: string",
  optional: "readonly name?: string",
} as const;

const objectType = (entries: ReadonlyArray<string>, name: keyof typeof nameEntry): string =>
  `{ ${[nameEntry[name], ...entries].join("; ")} }`;

const typeKeyBySite = { module: "bound", helper: "type" } as const;
const statesByForm: Record<StatesForm, string> = {
  one: "S.Loading",
  list: "[S.Loading, S.Retrying]",
};
/** A list of states reads the shared `_tag`; one state reads `url`. */
const stateReadByForm: Record<StatesForm, string> = {
  one: "state.url",
  list: "state._tag",
};

interface CellSpec {
  readonly success: Kind;
  readonly error: Kind;
  readonly statesForm: StatesForm;
  readonly site: Site;
  readonly runForm: RunForm;
  readonly container: Container;
  readonly onSuccess: HandlerState;
  readonly onFailure: HandlerState;
}

/** Renders one cell; `$ID` stands for the cell id, so equal specs render equal code. */
const renderCell = (spec: CellSpec): string => {
  const { success, error, statesForm, site, runForm, container } = spec;
  const typeKey = typeKeyBySite[site];
  const types = { onSuccess: success[typeKey], onFailure: error[typeKey] };
  const kinds = { onSuccess: success, onFailure: error };
  const states = { onSuccess: spec.onSuccess, onFailure: spec.onFailure };
  const handlers = ["onSuccess", "onFailure"] as const;
  const stateRead = stateReadByForm[statesForm];
  const load = { module: "load_$ID", helper: "load" }[site];
  const run = {
    plain: `() => ${load}("/")`,
    context: `({ state }) => ${load}(${stateRead})`,
    gen: `({ state }) => Effect.gen(function* () { return yield* ${load}(${stateRead}); })`,
  }[runForm];
  const parameterType = (handler: "onSuccess" | "onFailure", state: HandlerState): string => {
    if (state.slot === "absent") return types[handler];
    return parameterTypeByForm[state.parameter](types[handler]);
  };

  /** Declarations a cell needs: at module level for `module`, as helper parameters for `helper`. */
  const declarations: Array<{ readonly name: string; readonly type: string }> = [];
  let options: string;
  if (container === "inline") {
    const entries = handlers.flatMap((handler) => {
      const state = states[handler];
      if (state.slot === "absent") return [];
      const type = parameterType(handler, state);
      if (state.slot === "given" && state.parameter === "run") {
        return [`${handler}: ${contextualLambda(handler, kinds[handler], type, stateRead)}`];
      }
      if (state.slot === "given") {
        return [`${handler}: ${annotatedLambda(handler, type, stateRead)}`];
      }
      if (state.slot === "optional") {
        declarations.push({
          name: `${handler}Part_$ID`,
          type: `{ readonly ${handler}?: ${handlerType(handler, type)} }`,
        });
        return [`...${handler}Part_$ID`];
      }
      declarations.push({
        name: `${handler}_$ID`,
        type: `(${handlerType(handler, type)}) | undefined`,
      });
      return [`${handler}: ${handler}_$ID`];
    });
    options = `{ ${entries.join(", ")} }`;
  } else if (container === "variable") {
    const entries = handlers.flatMap((handler) => {
      const state = states[handler];
      if (state.slot === "absent") return [];
      const fn = handlerType(handler, parameterType(handler, state));
      const entryBySlot: Record<Slot, string> = {
        given: `readonly ${handler}: ${fn}`,
        optional: `readonly ${handler}?: ${fn}`,
        maybe: `readonly ${handler}: (${fn}) | undefined`,
      };
      return [entryBySlot[state.slot]];
    });
    declarations.push({ name: "options_$ID", type: objectType(entries, "optional") });
    options = "options_$ID";
  } else {
    /** The first member keeps an optional handler; the second drops it. */
    const member = (keepOptional: boolean): ReadonlyArray<string> =>
      handlers.flatMap((handler) => {
        const state = states[handler];
        if (state.slot === "absent") return [];
        const fn = handlerType(handler, parameterType(handler, state));
        if (state.slot === "given" || (state.slot === "optional" && keepOptional)) {
          return [`readonly ${handler}: ${fn}`];
        }
        if (state.slot === "maybe") return [`readonly ${handler}: (${fn}) | undefined`];
        return [];
      });
    declarations.push({
      name: "options_$ID",
      type: `${objectType(member(true), "optional")} | ${objectType(member(false), "required")}`,
    });
    options = "options_$ID";
  }

  const call = `base.task(${statesByForm[statesForm]}, ${run}, ${options})`;
  if (site === "module") {
    return [
      `declare const ${load}: (url: string) => Effect.Effect<${success.bound}, ${error.bound}>;`,
      ...declarations.map(
        (declaration) => `declare const ${declaration.name}: ${declaration.type};`,
      ),
      `export const $ID = ${call};`,
    ].join("\n");
  }
  const parameters = ["R", success.parameter, error.parameter].filter(
    (parameter): parameter is string => parameter !== undefined,
  );
  const helperParameters = [
    `load: (url: string) => Effect.Effect<${success.type}, ${error.type}, R>`,
    ...declarations.map((declaration) => `${declaration.name}: ${declaration.type}`),
  ];
  return [
    `export const $ID = <${parameters.join(", ")}>(${helperParameters.join(", ")}) =>`,
    `  ${call};`,
  ].join("\n");
};

/** The rule's verdict for one cell spec. */
const compilesByRule = (spec: CellSpec): boolean =>
  (spec.success.free || spec.onSuccess.slot === "given") &&
  (spec.error.free || spec.onFailure.slot === "given");

/**
 * Adds the full product of the given kinds and parameter forms with every other
 * dimension. A cell spec whose code equals an earlier cell's (for example a type
 * parameter replaced by its bound at module level) is skipped.
 */
const addProduct = (
  cells: Array<Cell>,
  codeSet: Set<string>,
  productSuccessKinds: ReadonlyArray<Kind>,
  productErrorKinds: ReadonlyArray<Kind>,
  parameters: ReadonlyArray<ParameterForm>,
): void => {
  const states = handlerStates(parameters);
  for (const statesForm of statesForms) {
    for (const site of sites) {
      for (const runForm of runForms) {
        for (const container of containers) {
          for (const success of productSuccessKinds) {
            for (const error of productErrorKinds) {
              for (const onSuccess of states) {
                for (const onFailure of states) {
                  const spec: CellSpec = {
                    success,
                    error,
                    statesForm,
                    site,
                    runForm,
                    container,
                    onSuccess,
                    onFailure,
                  };
                  const template = renderCell(spec);
                  if (codeSet.has(template)) continue;
                  codeSet.add(template);
                  const id = [
                    "c",
                    statesForm,
                    site,
                    runForm,
                    container,
                    success.name,
                    error.name,
                    handlerStateName(onSuccess).replace("-", "_"),
                    handlerStateName(onFailure).replace("-", "_"),
                  ].join("_");
                  cells.push({
                    id,
                    code: template.replaceAll("$ID", id),
                    compiles: compilesByRule(spec),
                    group: `generated/${statesForm}/${container}`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
};

export const generatedCells = (full: boolean): ReadonlyArray<Cell> => {
  const cells: Array<Cell> = [];
  const codeSet = new Set<string>();
  if (full) {
    addProduct(cells, codeSet, successKinds, errorKinds, allParameterForms);
    return cells;
  }
  addProduct(cells, codeSet, successKinds, errorKinds, ["run"]);
  addProduct(
    cells,
    codeSet,
    successKinds.filter((success) => representativeSuccessNames.has(success.name)),
    errorKinds.filter((error) => representativeErrorNames.has(error.name)),
    allParameterForms,
  );
  return cells;
};

// ---------------------------------------------------------------------------
// Named fixed cases: every earlier counterexample and review probe
// (emfix r1 probe95.ts, r2 probe95r2.ts + probe95r2c.ts, r3 probe95r3.ts).
// The verdict is the rule's verdict, not the verdict an earlier round wrote.
// ---------------------------------------------------------------------------

const fixed = (id: string, compiles: boolean, code: string): Cell => ({
  id,
  code: code.replaceAll("$ID", id),
  compiles,
  group: "fixed",
});

export const fixedCells: ReadonlyArray<Cell> = [
  // emfix round 1 (probe95.ts)
  fixed(
    "r1_P1",
    true,
    `export const $ID = <Err>(run: Effect.Effect<number, Err>) =>
  base.task(S.Loading, () => run, { onSuccess: (data) => E.Loaded({ data }), onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r1_P2",
    true,
    `export const $ID = <Err>(run: Effect.Effect<Done, Err>) =>
  base.task(S.Loading, () => run, { onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r1_P3",
    true,
    `export const $ID = <A>(run: Effect.Effect<A>) => base.task(S.Loading, () => run, { onSuccess: () => E.Done });`,
  ),
  fixed(
    "r1_P3b",
    true,
    `export const $ID = <A, Err>(run: Effect.Effect<A, Err>) =>
  base.task(S.Loading, () => run, { onSuccess: () => E.Done, onFailure: () => E.Done });`,
  ),
  fixed("r1_P4", true, `export const $ID = base.task(S.Loading, () => Effect.never, {});`),
  fixed(
    "r1_P6",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => {
  const url: string = state.url;
  const tag: "Loading" = state._tag;
  return Effect.succeed(E.Failed({ error: url + tag }));
}, {});`,
  ),
  fixed(
    "r1_P6m",
    true,
    `export const $ID = base.task([S.Loading, S.Retrying], ({ state }) => {
  const tag: "Loading" | "Retrying" = state._tag;
  return Effect.succeed(E.Failed({ error: state.url + tag }));
}, {});`,
  ),
  fixed("r1_P7", true, `export const $ID = base.task(S.Ready, () => Effect.succeed(E.Done), {});`),
  fixed(
    "r1_P8",
    true,
    `const loadFn_$ID = Effect.fn("load")(function* (ctx: { readonly state: { readonly url: string } }) {
  yield* Effect.log(ctx.state.url);
  return E.Done;
});
export const $ID = base.task(S.Loading, loadFn_$ID, {});`,
  ),
  fixed("r1_P9", false, `export const $ID = base.task(S.Loading, () => Effect.void, {});`),
  fixed(
    "r1_P10",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.orDie(Effect.fail(new LoadError())), {});`,
  ),
  fixed(
    "r1_P11",
    false,
    `export const $ID = <Err>(run: Effect.Effect<Done, Err>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r1_P12",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), {
  onFailure: (error) => E.Failed({ error: error._tag }),
});`,
  ),
  // emfix round 2 (probe95r2.ts, probe95r2c.ts)
  fixed(
    "r2_Q1",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r2_Q2",
    true,
    `export const $ID = <Err>(run: Effect.Effect<Done, Err>) =>
  base.task(S.Loading, () => run, { onFailure: (error) => E.Failed({ error: String(error) }) });`,
  ),
  fixed(
    "r2_Q3",
    true,
    `export const $ID = <N extends number>(run: Effect.Effect<N>) =>
  base.task(S.Loading, () => run, { onSuccess: (data) => E.Loaded({ data }) });`,
  ),
  fixed(
    "r2_Q4",
    false,
    `export const $ID = <Err extends LoadError>(run: Effect.Effect<Done, Err>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r2_Q5",
    false,
    `export const $ID = <N extends number>(run: Effect.Effect<N>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r2_Q6",
    true,
    `export const $ID = <R>(run: Effect.Effect<Done, never, R>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r2_Q7",
    true,
    `export const $ID = <Err>(load: (url: string) => Effect.Effect<number, Err>) =>
  base.task(S.Loading, ({ state }) => load(state.url), {
    onSuccess: (data) => E.Loaded({ data }),
    onFailure: () => E.Failed({ error: "x" }),
  });`,
  ),
  fixed(
    "r2_Q8",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.succeed<Done | number>(E.Done), {});`,
  ),
  fixed(
    "r2_Q9",
    true,
    `export const $ID = <Err>(run: Effect.Effect<Done, Err>) =>
  base.task([S.Loading, S.Retrying], () => run, { onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r2_Q11",
    false,
    `export const $ID = <Err>(run: Effect.Effect<number, Err>) =>
  base.task(S.Loading, () => run, { onSuccess: (data) => E.Loaded({ data }) });`,
  ),
  fixed(
    "r2_Q12",
    false,
    `export const $ID = <A>(run: Effect.Effect<A, LoadError>) =>
  base.task(S.Loading, () => run, { onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r2_Q13",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), { onFailure: undefined });`,
  ),
  fixed(
    "r2_Q14",
    true,
    `export const $ID = (run: Effect.Effect<any>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r2_V1",
    true,
    `export const $ID = <Ev extends Done, Err>(run: Effect.Effect<Ev, Err>) =>
  base.task(S.Loading, () => run, { onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r2_V2",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>) =>
  base.task(S.Loading, () => run, { onSuccess: (event) => event });`,
  ),
  fixed(
    "r2_V3",
    true,
    `export const $ID = <Ev extends Done, Err>(run: Effect.Effect<Ev, Err>) =>
  base.task(S.Loading, () => run, { onSuccess: (event) => event, onFailure: () => E.Failed({ error: "x" }) });`,
  ),
  fixed(
    "r2_V4",
    true,
    `export const $ID = <Ev extends Done>(event: Ev) =>
  base.task(S.Loading, () => Effect.sleep("1 second").pipe(Effect.as(event)), {});`,
  ),
  // emfix round 3 (probe95r3.ts); U1, U4, U6 are out of domain (spec.md, Acceptance check).
  fixed(
    "r3_U2",
    true,
    `export const $ID = base.task(S.Loading,
  ({ state }) => (state.url.length > 0 ? Effect.succeed(E.Done) : Effect.fail(new LoadError())),
  { onFailure: (e) => { notAny<typeof e>(e); return E.Failed({ error: e._tag }); } });`,
  ),
  fixed(
    "r3_U3",
    false,
    `export const $ID = base.task(S.Loading,
  ({ state }) => (state.url.length > 0 ? Effect.succeed(E.Done) : Effect.fail(new LoadError())), {});`,
  ),
  fixed(
    "r3_U5",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), flag ? { onFailure: () => E.Done } : {});`,
  ),
  fixed(
    "r3_U7",
    false,
    `export const $ID = base.task(S.Loading, () => (flag ? Effect.succeed(E.Done) : Effect.succeed(42)), {});`,
  ),
  fixed("r3_N1", true, `export const $ID = base.task(S.Loading, () => Effect.never, {});`),
  fixed("r3_N2", true, `export const $ID = base.task(S.Loading, () => Effect.die("x"), {});`),
  fixed(
    "r3_N3",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), {});`,
  ),
  fixed(
    "r3_N4",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), {
  onFailure: (e) => { notAny<typeof e>(e); return E.Failed({ error: e._tag }); } });`,
  ),
  fixed(
    "r3_N5",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), { onSuccess: (v) => v, onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_N6",
    true,
    `export const $ID = <Err>(run: Effect.Effect<never, Err>) => base.task(S.Loading, () => run, { onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_V1",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.void, { onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_V2",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.void, { onSuccess: () => E.Done });`,
  ),
  fixed(
    "r3_V3",
    true,
    `export const $ID = <R>(run: Effect.Effect<void, never, R>) => base.task(S.Loading, () => run, { onSuccess: () => E.Done });`,
  ),
  fixed(
    "r3_V4",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.succeed(flag ? E.Done : undefined), {});`,
  ),
  fixed(
    "r3_V5",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => Effect.asVoid(Effect.succeed(state.url)), { onSuccess: () => E.Done });`,
  ),
  fixed(
    "r3_B1",
    true,
    `export const $ID = <M extends typeof base>(m: M) => m.task(S.Loading, () => Effect.succeed(E.Done), {});`,
  ),
  fixed(
    "r3_B2",
    false,
    `export const $ID = <M extends typeof base>(m: M) => m.task(S.Loading, () => Effect.fail(new LoadError()), {});`,
  ),
  fixed(
    "r3_B3",
    true,
    `export const $ID = <M extends typeof base, Ev extends Done>(m: M, ev: Ev) => m.task(S.Loading, () => Effect.succeed(ev), {});`,
  ),
  fixed(
    "r3_B4",
    true,
    `export const $ID = base
  .task(S.Loading, () => Effect.succeed(E.Done), {})
  .task(S.Ready, () => Effect.succeed(42), { onSuccess: (n) => { notAny<typeof n>(n); return E.Loaded({ data: n }); } });`,
  ),
  fixed(
    "r3_B5",
    true,
    `export function $ID(this: typeof base) { return this.task(S.Loading, () => Effect.succeed(E.Done), {}); }`,
  ),
  fixed(
    "r3_G1",
    true,
    `export const $ID = base.task(S.Loading,
  ({ state }) => Effect.gen(function* () { const n = yield* loadN(state.url); return E.Loaded({ data: n }); }),
  { onFailure: (e) => { notAny<typeof e>(e); return E.Failed({ error: e._tag }); } });`,
  ),
  fixed(
    "r3_G2",
    false,
    `export const $ID = base.task(S.Loading,
  ({ state }) => Effect.gen(function* () { const n = yield* loadN(state.url); return E.Loaded({ data: n }); }), {});`,
  ),
  fixed(
    "r3_G3",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => Effect.gen(function* () { return yield* loadN(state.url); }), {
  onSuccess: (n) => { notAny<typeof n>(n); return E.Loaded({ data: n }); }, onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_G4",
    true,
    `export const $ID = <Ev extends Done>(ev: Ev) =>
  base.task(S.Loading, () => Effect.gen(function* () { yield* Effect.sleep("1 second"); return ev; }), {});`,
  ),
  fixed(
    "r3_G5",
    true,
    `export const $ID = base.task(S.Loading,
  ({ state }) => Effect.gen(function* () { if (state.url === "") return E.Done; return E.Failed({ error: state.url }); }), {});`,
  ),
  fixed(
    "r3_C1",
    true,
    `export const $ID = <Ev extends Done, A extends Ev>(run: Effect.Effect<A>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_C2",
    true,
    `export const $ID = <T>(run: Effect.Effect<T extends string ? Done : Failed>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_C3",
    false,
    `export const $ID = <T>(run: Effect.Effect<T extends string ? Done : number>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_C4",
    true,
    `interface ByKey_$ID { readonly a: Done; readonly b: Failed }
export const $ID = <K extends keyof ByKey_$ID>(run: Effect.Effect<ByKey_$ID[K]>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_C5",
    true,
    `export const $ID = <T>(run: Effect.Effect<Done, T extends string ? LoadError : never>) =>
  base.task(S.Loading, () => run, { onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_C6",
    true,
    `export const $ID = <Err extends Done & Failed>(run: Effect.Effect<Done, Err>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_C7",
    true,
    `export const $ID = <Err extends never = never>(run: Effect.Effect<Done, Err>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_T1",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => loadN(state.url), {
  onSuccess: (n, { state }) => { notAny<typeof n>(n); notAny<typeof state>(state); return E.Loaded({ data: n }); },
  onFailure: (e) => { notAny<typeof e>(e); return E.Done; } });`,
  ),
  // T2/T3: the handler parameters keep their types: the call compiles, and the body's
  // \`const x: number = <param>\` must fail. Rendered here with @ts-expect-error on those lines.
  fixed(
    "r3_T2",
    true,
    `export const $ID = <Ev extends Done, Err>(run: Effect.Effect<Ev, Err>) =>
  base.task(S.Loading, ({ state }) => (state.url === "" ? run : run), {
    onFailure: (e, { state }) => {
      // @ts-expect-error -- e is Err, not number
      const x: number = e;
      // @ts-expect-error -- state is Loading, not number
      const y: number = state;
      return E.Failed({ error: String(x + y) });
    },
  });`,
  ),
  fixed(
    "r3_T3",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>) =>
  base.task(S.Loading, () => run, { onSuccess: (event) => {
    // @ts-expect-error -- event is Ev, not number
    const x: number = event;
    return E.Failed({ error: String(x) });
  } });`,
  ),
  fixed(
    "r3_T4",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => Effect.succeed(E.Failed({ error: state.url })), {
  onSuccess: (ev) => { notAny<typeof ev>(ev); return ev; } });`,
  ),
  fixed(
    "r3_K1",
    false,
    `export const $ID = <Err extends LoadError>(run: Effect.Effect<Done, Err>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_K2",
    true,
    `export const $ID = <Err extends LoadError>(run: Effect.Effect<Done, Err>) =>
  base.task(S.Loading, () => run, { onFailure: (e) => E.Failed({ error: e._tag }) });`,
  ),
  fixed(
    "r3_M1",
    false,
    `export const $ID = <A extends Done | number>(run: Effect.Effect<A>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_M2",
    true,
    `export const $ID = <A extends Done | number>(run: Effect.Effect<A>) =>
  base.task(S.Loading, () => run, { onSuccess: () => E.Done });`,
  ),
  fixed(
    "r3_NB",
    true,
    `export const $ID = <A extends never>(run: Effect.Effect<A>) => base.task(S.Loading, () => run, {});`,
  ),
  fixed(
    "r3_W1",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>, opts: { name?: string; onSuccess?: (value: Ev) => Ev }) =>
  base.task(S.Loading, () => run, opts);`,
  ),
  fixed(
    "r3_W2",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>, opts: { name?: string } | { name?: string; onSuccess: (value: Ev) => Ev }) =>
  base.task(S.Loading, () => run, opts);`,
  ),
  fixed(
    "r3_W3",
    true,
    `export const $ID = (run: Effect.Effect<Done>, opts: { name?: string; onSuccess?: (value: Done) => Done }) =>
  base.task(S.Loading, () => run, opts);`,
  ),
  fixed(
    "r3_W4",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>, map: ((value: Ev) => Ev) | undefined) =>
  base.task(S.Loading, () => run, { onSuccess: map });`,
  ),
  fixed(
    "r3_W5",
    true,
    `export const $ID = <Ev extends Done>(run: Effect.Effect<Ev>, opts: { name?: string }) =>
  base.task(S.Loading, () => run, opts);`,
  ),
  fixed(
    "r3_A1",
    false,
    `declare const runAnyErr_$ID: Effect.Effect<Done, any>;
export const $ID = base.task(S.Loading, () => runAnyErr_$ID, {});`,
  ),
  fixed(
    "r3_A2",
    true,
    `declare const runAnyVal_$ID: Effect.Effect<any>;
export const $ID = base.task(S.Loading, () => runAnyVal_$ID, {});`,
  ),
  fixed(
    "r3_A3",
    true,
    `declare const runAnyErr_$ID: Effect.Effect<Done, any>;
export const $ID = base.task(S.Loading, () => runAnyErr_$ID, { onFailure: (e) => E.Failed({ error: String(e) }) });`,
  ),
  fixed(
    "r3_F1",
    true,
    `export const $ID = base.task([S.Loading, S.Ready] as const, () => Effect.succeed(E.Done), {});`,
  ),
  fixed(
    "r3_F2",
    true,
    `export const $ID = <St extends typeof S.Loading>(state: St) => base.task(state, () => Effect.succeed(E.Done), {});`,
  ),
  fixed(
    "r3_F3",
    true,
    `export const $ID = <NS extends ReadonlyArray<typeof S.Loading | typeof S.Ready>>(states: NS) =>
  base.task(states, ({ state }) => Effect.succeed(E.Failed({ error: state._tag })), {});`,
  ),
  fixed(
    "r3_F4",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => Effect.succeed(state.url), {
  onSuccess: (url) => E.Failed({ error: url }), name: "named" });`,
  ),
  fixed(
    "r3_R3a",
    true,
    `export const $ID = base.task(S.Loading, ({ state }) => Effect.succeed(state.url), {
  onSuccess: (url: string) => E.Failed({ error: url }), onFailure: () => E.Done });`,
  ),
  fixed(
    "r3_R3b",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.succeed(E.Done), { onSuccess: undefined });`,
  ),
  // Generic machine site: the receiver is a type parameter bounded by the machine.
  fixed(
    "em95_genericMachineFailingWithHandler",
    true,
    `export const $ID = <M extends typeof base>(m: M) =>
  m.task(S.Loading, ({ state }) => loadN(state.url), { onSuccess: (n) => E.Loaded({ data: n }), onFailure: (e) => E.Failed({ error: e._tag }) });`,
  ),
  fixed(
    "em95_genericMachineNonEventWithoutOnSuccess",
    false,
    `export const $ID = <M extends typeof base>(m: M) =>
  m.task(S.Loading, () => Effect.succeed(42), {});`,
  ),
  // The issue's own reproduction (#95): a failing task and a non-event task without handlers.
  fixed(
    "issue95_failingNoOnFailure",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.fail(new LoadError()), {});`,
  ),
  fixed(
    "issue95_nonEventNoOnSuccess",
    false,
    `export const $ID = base.task(S.Loading, () => Effect.succeed(42), {});`,
  ),
  fixed(
    "issue95_validShortForm",
    true,
    `export const $ID = base.task(S.Loading, () => Effect.succeed(E.Done), {});`,
  ),
  // em95 review round 1, B1: an optional, maybe, union or exported-type handler whose
  // parameter is `any` must not let a non-event success skip onSuccess.
  fixed(
    "em95r1_b1a",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: any) => Done };
export const $ID = base.task(S.Loading, runNum, opt_$ID);`,
  ),
  fixed(
    "em95r1_b1b",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: any) => Done };
export const $ID = base.task([S.Loading, S.Retrying], runNum, opt_$ID);`,
  ),
  fixed(
    "em95r1_b1c",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: any) => Done };
export const $ID = base.task(S.Loading, ({ state }) => loadNum(state.url), opt_$ID);`,
  ),
  fixed(
    "em95r1_b1d",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: any) => Done };
export const $ID = base.task(
  S.Loading,
  ({ state }) =>
    Effect.gen(function* () {
      return yield* loadNum(state.url);
    }),
  opt_$ID,
);`,
  ),
  fixed(
    "em95r1_b1e",
    false,
    `declare const maybe_$ID: { readonly onSuccess: ((value: any) => Done) | undefined };
export const $ID = base.task(S.Loading, runNum, maybe_$ID);`,
  ),
  fixed(
    "em95r1_b1f",
    false,
    `declare const union_$ID: { readonly onSuccess: (value: any) => Done } | { readonly name: string };
export const $ID = base.task(S.Loading, runNum, union_$ID);`,
  ),
  fixed(
    "em95r1_b1g",
    false,
    `declare const exported_$ID: TaskOptions<any, any, any, never, Done, Done>;
export const $ID = base.task(S.Loading, runNum, exported_$ID);`,
  ),
  fixed(
    "em95r1_b1h",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: unknown) => Done };
export const $ID = base.task(S.Loading, runNum, opt_$ID);`,
  ),
  fixed(
    "em95r1_b1i",
    false,
    `declare const opt_$ID: { readonly name?: string; readonly onSuccess?: (value: number) => Done };
export const $ID = base.task(S.Loading, runNum, opt_$ID);`,
  ),
  fixed(
    "em95r1_b1j",
    true,
    `export const $ID = base.task(S.Loading, runNum, { onSuccess: (_value: any) => E.Done });`,
  ),
  fixed(
    "em95r1_b1k",
    false,
    `declare const opt_$ID: { readonly onFailure?: (error: any) => Failed };
export const $ID = base.task(S.Loading, () => loadDoneErr("/"), opt_$ID);`,
  ),
  fixed(
    "em95r1_b1l",
    false,
    `declare const opt_$ID: {
  readonly onSuccess?: (value: any) => Done;
  readonly onFailure: (error: LoadError) => Failed;
};
export const $ID = base.task(S.Loading, () => loadN("/"), opt_$ID);`,
  ),
];

/** The module that every shard starts with; `LIB` is the library under test. */
export const preamble = `// @effect-diagnostics anyUnknownInErrorContext:off
// @effect-diagnostics deterministicKeys:off
// @effect-diagnostics missingPipeableSignature:off
// @effect-diagnostics unnecessaryEffectGen:off
import { Data, Effect, Schema } from "effect";
import { Event, Machine, State, type TaskOptions } from "LIB";

class LoadError extends Data.TaggedError("LoadError")<{}> {}
const S = State({ Loading: { url: Schema.String }, Retrying: { url: Schema.String }, Ready: {} });
const E = Event({ Loaded: { data: Schema.Finite }, Done: {}, Failed: { error: Schema.String } });
type Done = typeof E.Done;
type Failed = ReturnType<typeof E.Failed>;
const base = Machine.make({ state: S, event: E, initial: S.Loading({ url: "/" }) }).on(
  S.Loading,
  E.Done,
  () => S.Ready,
);
declare const flag: boolean;
declare const loadN: (url: string) => Effect.Effect<number, LoadError>;
declare const loadNum: (url: string) => Effect.Effect<number>;
declare const runNum: () => Effect.Effect<number>;
declare const loadDoneErr: (url: string) => Effect.Effect<Done, LoadError>;
/** Rejects an argument typed \`any\`. */
declare const notAny: <T>(value: 0 extends 1 & T ? never : T) => void;
declare const marker: unique symbol;
/** A type no domain type reaches, except any and never. */
type Marker = typeof marker;
export type Imported = TaskOptions<never, never, never, never, never, never>;
`;
