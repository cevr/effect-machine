import { __exportAll } from "./_virtual/_rolldown/runtime.js";
import { getTag } from "./internal/utils.js";
import { ProvisionValidationError, SlotProvisionError } from "./errors.js";
import { persist } from "./persistence/persistent-machine.js";
import { MachineContextTag } from "./slot.js";
import { findTransitions, invalidateIndex } from "./internal/transition.js";
import { createActor } from "./actor.js";
import { Cause, Effect, Exit, Option, Scope } from "effect";
//#region src-v3/machine.ts
var machine_exports = /* @__PURE__ */ __exportAll({
  BuiltMachine: () => BuiltMachine,
  Machine: () => Machine,
  findTransitions: () => findTransitions,
  make: () => make,
  spawn: () => spawn,
});
/**
 * A finalized machine ready for spawning.
 *
 * Created by calling `.build()` on a `Machine`. This is the only type
 * accepted by `Machine.spawn` and `ActorSystem.spawn` (regular overload).
 * Testing utilities (`simulate`, `createTestHarness`, etc.) still accept `Machine`.
 */
var BuiltMachine = class {
  /** @internal */
  _inner;
  /** @internal */
  constructor(machine) {
    this._inner = machine;
  }
  get initial() {
    return this._inner.initial;
  }
  persist(config) {
    return this._inner.persist(config);
  }
};
/**
 * Machine definition with fluent builder API.
 *
 * Type parameters:
 * - `State`: The state union type
 * - `Event`: The event union type
 * - `R`: Effect requirements
 * - `_SD`: State schema definition (for compile-time validation)
 * - `_ED`: Event schema definition (for compile-time validation)
 * - `GD`: Guard definitions
 * - `EFD`: Effect definitions
 */
var Machine = class Machine {
  initial;
  /** @internal */ _transitions;
  /** @internal */ _spawnEffects;
  /** @internal */ _backgroundEffects;
  /** @internal */ _finalStates;
  /** @internal */ _guardsSchema;
  /** @internal */ _effectsSchema;
  /** @internal */ _guardHandlers;
  /** @internal */ _effectHandlers;
  /** @internal */ _slots;
  stateSchema;
  eventSchema;
  /**
   * Context tag for accessing machine state/event/self in slot handlers.
   * Uses shared module-level tag for all machines.
   */
  Context = MachineContextTag;
  get transitions() {
    return this._transitions;
  }
  get spawnEffects() {
    return this._spawnEffects;
  }
  get backgroundEffects() {
    return this._backgroundEffects;
  }
  get finalStates() {
    return this._finalStates;
  }
  get guardsSchema() {
    return this._guardsSchema;
  }
  get effectsSchema() {
    return this._effectsSchema;
  }
  /** @internal */
  constructor(initial, stateSchema, eventSchema, guardsSchema, effectsSchema) {
    this.initial = initial;
    this._transitions = [];
    this._spawnEffects = [];
    this._backgroundEffects = [];
    this._finalStates = /* @__PURE__ */ new Set();
    this._guardsSchema = guardsSchema;
    this._effectsSchema = effectsSchema;
    this._guardHandlers = /* @__PURE__ */ new Map();
    this._effectHandlers = /* @__PURE__ */ new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;
    this._slots = {
      guards:
        this._guardsSchema !== void 0
          ? this._guardsSchema._createSlots((name, params) =>
              Effect.flatMap(Effect.serviceOptional(this.Context).pipe(Effect.orDie), (ctx) => {
                const handler = this._guardHandlers.get(name);
                if (handler === void 0)
                  return Effect.die(
                    new SlotProvisionError({
                      slotName: name,
                      slotType: "guard",
                    }),
                  );
                const result = handler(params, ctx);
                return typeof result === "boolean" ? Effect.succeed(result) : result;
              }),
            )
          : {},
      effects:
        this._effectsSchema !== void 0
          ? this._effectsSchema._createSlots((name, params) =>
              Effect.flatMap(Effect.serviceOptional(this.Context).pipe(Effect.orDie), (ctx) => {
                const handler = this._effectHandlers.get(name);
                if (handler === void 0)
                  return Effect.die(
                    new SlotProvisionError({
                      slotName: name,
                      slotType: "effect",
                    }),
                  );
                return handler(params, ctx);
              }),
            )
          : {},
    };
  }
  on(stateOrStates, event, handler) {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    for (const s of states) this.addTransition(s, event, handler, false);
    return this;
  }
  reenter(stateOrStates, event, handler) {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    for (const s of states) this.addTransition(s, event, handler, true);
    return this;
  }
  /**
   * Register a wildcard transition that fires from any state when no specific transition matches.
   * Specific `.on()` transitions always take priority over `.onAny()`.
   */
  onAny(event, handler) {
    const transition = {
      stateTag: "*",
      eventTag: getTag(event),
      handler,
      reenter: false,
    };
    this._transitions.push(transition);
    invalidateIndex(this);
    return this;
  }
  /** @internal */
  addTransition(state, event, handler, reenter) {
    const transition = {
      stateTag: getTag(state),
      eventTag: getTag(event),
      handler,
      reenter,
    };
    this._transitions.push(transition);
    invalidateIndex(this);
    return this;
  }
  /**
   * State-scoped effect that is forked on state entry and automatically cancelled on state exit.
   * Use effect slots defined via `Slot.Effects` for the actual work.
   *
   * @example
   * ```ts
   * const MyEffects = Slot.Effects({
   *   fetchData: { url: Schema.String },
   * });
   *
   * machine
   *   .spawn(State.Loading, ({ effects, state }) => effects.fetchData({ url: state.url }))
   *   .build({
   *     fetchData: ({ url }, { self }) =>
   *       Effect.gen(function* () {
   *         yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
   *         const data = yield* Http.get(url);
   *         yield* self.send(Event.Loaded({ data }));
   *       }),
   *   });
   * ```
   */
  spawn(state, handler) {
    const stateTag = getTag(state);
    this._spawnEffects.push({
      stateTag,
      handler,
    });
    invalidateIndex(this);
    return this;
  }
  /**
   * State-scoped task that runs on entry and sends success/failure events.
   * Interrupts do not emit failure events.
   */
  task(state, run, options) {
    const handler = Effect.fn("effect-machine.task")(function* (ctx) {
      const exit = yield* Effect.exit(run(ctx));
      if (Exit.isSuccess(exit)) {
        yield* ctx.self.send(options.onSuccess(exit.value, ctx));
        yield* Effect.yieldNow();
        return;
      }
      const cause = exit.cause;
      if (Cause.isInterruptedOnly(cause)) return;
      if (options.onFailure !== void 0) {
        yield* ctx.self.send(options.onFailure(cause, ctx));
        yield* Effect.yieldNow();
        return;
      }
      return yield* Effect.failCause(cause).pipe(Effect.orDie);
    });
    return this.spawn(state, handler);
  }
  /**
   * Machine-lifetime effect that is forked on actor spawn and runs until the actor stops.
   * Use effect slots defined via `Slot.Effects` for the actual work.
   *
   * @example
   * ```ts
   * const MyEffects = Slot.Effects({
   *   heartbeat: {},
   * });
   *
   * machine
   *   .background(({ effects }) => effects.heartbeat())
   *   .build({
   *     heartbeat: (_, { self }) =>
   *       Effect.forever(
   *         Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(Event.Ping)))
   *       ),
   *   });
   * ```
   */
  background(handler) {
    this._backgroundEffects.push({ handler });
    return this;
  }
  final(state) {
    const stateTag = getTag(state);
    this._finalStates.add(stateTag);
    return this;
  }
  /**
   * Finalize the machine. Returns a `BuiltMachine` — the only type accepted by `Machine.spawn`.
   *
   * - Machines with slots: pass implementations as the first argument.
   * - Machines without slots: call with no arguments.
   */
  build(...args) {
    const handlers = args[0];
    if (handlers !== void 0) {
      const requiredSlots = /* @__PURE__ */ new Set();
      if (this._guardsSchema !== void 0)
        for (const name of Object.keys(this._guardsSchema.definitions)) requiredSlots.add(name);
      if (this._effectsSchema !== void 0)
        for (const name of Object.keys(this._effectsSchema.definitions)) requiredSlots.add(name);
      const providedSlots = new Set(Object.keys(handlers));
      const missing = [];
      const extra = [];
      for (const name of requiredSlots) if (!providedSlots.has(name)) missing.push(name);
      for (const name of providedSlots) if (!requiredSlots.has(name)) extra.push(name);
      if (missing.length > 0 || extra.length > 0)
        throw new ProvisionValidationError({
          missing,
          extra,
        });
      const result = new Machine(
        this.initial,
        this.stateSchema,
        this.eventSchema,
        this._guardsSchema,
        this._effectsSchema,
      );
      result._transitions = [...this._transitions];
      result._finalStates = new Set(this._finalStates);
      result._spawnEffects = [...this._spawnEffects];
      result._backgroundEffects = [...this._backgroundEffects];
      const anyHandlers = handlers;
      if (this._guardsSchema !== void 0)
        for (const name of Object.keys(this._guardsSchema.definitions))
          result._guardHandlers.set(name, anyHandlers[name]);
      if (this._effectsSchema !== void 0)
        for (const name of Object.keys(this._effectsSchema.definitions))
          result._effectHandlers.set(name, anyHandlers[name]);
      return new BuiltMachine(result);
    }
    return new BuiltMachine(this);
  }
  /** @internal Persist from raw Machine — prefer BuiltMachine.persist() */
  persist(config) {
    return persist(config)(this);
  }
  static make(config) {
    return new Machine(config.initial, config.state, config.event, config.guards, config.effects);
  }
};
const make = Machine.make;
const spawn = Effect.fn("effect-machine.spawn")(function* (built, id) {
  const actor = yield* createActor(
    id ?? `actor-${Math.random().toString(36).slice(2)}`,
    built._inner,
  );
  const maybeScope = yield* Effect.serviceOption(Scope.Scope);
  if (Option.isSome(maybeScope)) yield* Scope.addFinalizer(maybeScope.value, actor.stop);
  return actor;
});
//#endregion
export { BuiltMachine, Machine, findTransitions, machine_exports, make, spawn };
