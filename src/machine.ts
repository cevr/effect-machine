/**
 * Machine namespace - fluent builder API for state machines.
 *
 * @example
 * ```ts
 * import { Machine, State, Event, Slot } from "effect-machine"
 *
 * const MyState = State({ Idle: {}, Running: { count: Schema.Number } })
 * const MyEvent = Event({ Start: {}, Stop: {} })
 *
 * const MyGuards = Slot.Guards({
 *   canStart: { threshold: Schema.Number },
 * })
 *
 * const MyEffects = Slot.Effects({
 *   notify: { message: Schema.String },
 * })
 *
 * const machine = Machine.make({
 *   state: MyState,
 *   event: MyEvent,
 *   guards: MyGuards,
 *   effects: MyEffects,
 *   initial: MyState.Idle,
 * })
 *   .on(MyState.Idle, MyEvent.Start, ({ state, guards, effects }) =>
 *     Effect.gen(function* () {
 *       if (yield* guards.canStart({ threshold: 5 })) {
 *         yield* effects.notify({ message: "Starting!" })
 *         return MyState.Running({ count: 0 })
 *       }
 *       return state
 *     })
 *   )
 *   .on(MyState.Running, MyEvent.Stop, () => MyState.Idle)
 *   .final(MyState.Idle)
 *   .provide({
 *     canStart: ({ threshold }) => Effect.succeed(threshold > 0),
 *     notify: ({ message }) => Effect.log(message),
 *   })
 * ```
 *
 * @module
 */
import type { Schema, Schedule, Scope, Context } from "effect";
import { Cause, Effect, Exit } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";

import type { TransitionResult } from "./internal/utils.js";
import { getTag } from "./internal/utils.js";
import type { TaggedOrConstructor, BrandedState, BrandedEvent } from "./internal/brands.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./schema.js";
import type { PersistentMachine, WithPersistenceConfig } from "./persistence/persistent-machine.js";
import { persist as persistImpl } from "./persistence/persistent-machine.js";
import { SlotProvisionError, ProvisionValidationError, UnprovidedSlotsError } from "./errors.js";
import { invalidateIndex } from "./internal/transition.js";
import type {
  GuardsSchema,
  EffectsSchema,
  GuardsDef,
  EffectsDef,
  GuardSlots,
  EffectSlots,
  GuardHandlers,
  EffectHandlers as SlotEffectHandlers,
  MachineContext,
} from "./slot.js";
import { MachineContextTag } from "./slot.js";

// ============================================================================
// Core types
// ============================================================================

/**
 * Self reference for sending events back to the machine
 */
export interface MachineRef<Event> {
  readonly send: (event: Event) => Effect.Effect<void>;
}

/**
 * Handler context passed to transition handlers
 */
export interface HandlerContext<State, Event, GD extends GuardsDef, ED extends EffectsDef> {
  readonly state: State;
  readonly event: Event;
  readonly guards: GuardSlots<GD>;
  readonly effects: EffectSlots<ED>;
}

/**
 * Handler context passed to state effect handlers (onEnter, spawn, background)
 */
export interface StateHandlerContext<State, Event, ED extends EffectsDef> {
  readonly state: State;
  readonly event: Event;
  readonly self: MachineRef<Event>;
  readonly effects: EffectSlots<ED>;
}

/**
 * Transition handler function
 */
export type TransitionHandler<S, E, NewState, GD extends GuardsDef, ED extends EffectsDef, R> = (
  ctx: HandlerContext<S, E, GD, ED>,
) => TransitionResult<NewState, R>;

/**
 * State effect handler function
 */
export type StateEffectHandler<S, E, ED extends EffectsDef, R> = (
  ctx: StateHandlerContext<S, E, ED>,
) => Effect.Effect<void, never, R>;

/**
 * Transition definition
 */
export interface Transition<State, Event, GD extends GuardsDef, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: TransitionHandler<State, Event, State, GD, ED, R>;
  readonly reenter?: boolean;
}

/**
 * Spawn effect - state-scoped forked effect
 */
export interface SpawnEffect<State, Event, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, ED, R>;
}

/**
 * Background effect - runs for entire machine lifetime
 */
export interface BackgroundEffect<State, Event, ED extends EffectsDef, R> {
  readonly handler: StateEffectHandler<State, Event, ED, R>;
}

// ============================================================================
// Options types
// ============================================================================

/** Options for `persist` */
export interface PersistOptions {
  readonly snapshotSchedule: Schedule.Schedule<unknown, { readonly _tag: string }>;
  readonly journalEvents: boolean;
  readonly machineType?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;
type NormalizeR<T> = IsAny<T> extends true ? T : IsUnknown<T> extends true ? never : T;

// ============================================================================
// MakeConfig
// ============================================================================

export interface MakeConfig<
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
  GD extends GuardsDef,
  EFD extends EffectsDef,
> {
  readonly state: MachineStateSchema<SD> & { Type: S };
  readonly event: MachineEventSchema<ED> & { Type: E };
  readonly guards?: GuardsSchema<GD>;
  readonly effects?: EffectsSchema<EFD>;
  readonly initial: S;
}

// ============================================================================
// Provide types
// ============================================================================

/** Check if a GuardsDef has any actual keys */
type HasGuardKeys<GD extends GuardsDef> = [keyof GD] extends [never]
  ? false
  : GD extends Record<string, never>
    ? false
    : true;

/** Check if an EffectsDef has any actual keys */
type HasEffectKeys<EFD extends EffectsDef> = [keyof EFD] extends [never]
  ? false
  : EFD extends Record<string, never>
    ? false
    : true;

/** Context type passed to guard/effect handlers */
export type SlotContext<State, Event> = MachineContext<State, Event, MachineRef<Event>>;

/** Combined handlers for provide() - guards and effects only */
export type ProvideHandlers<
  State,
  Event,
  GD extends GuardsDef,
  EFD extends EffectsDef,
  R,
> = (HasGuardKeys<GD> extends true ? GuardHandlers<GD, SlotContext<State, Event>, R> : object) &
  (HasEffectKeys<EFD> extends true
    ? SlotEffectHandlers<EFD, SlotContext<State, Event>, R>
    : object);

// ============================================================================
// Machine class
// ============================================================================

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
export class Machine<
  State,
  Event,
  R = never,
  _SD extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
> implements Pipeable {
  readonly initial: State;
  /** @internal */ readonly _transitions: Array<Transition<State, Event, GD, EFD, R>>;
  /** @internal */ readonly _spawnEffects: Array<SpawnEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _backgroundEffects: Array<BackgroundEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _finalStates: Set<string>;
  /** @internal */ readonly _guardsSchema?: GuardsSchema<GD>;
  /** @internal */ readonly _effectsSchema?: EffectsSchema<EFD>;
  /** @internal */ readonly _guardHandlers: Map<
    string,
    (params: unknown, ctx: SlotContext<State, Event>) => boolean | Effect.Effect<boolean, never, R>
  >;
  /** @internal */ readonly _effectHandlers: Map<
    string,
    (params: unknown, ctx: SlotContext<State, Event>) => Effect.Effect<void, never, R>
  >;
  /** @internal */ readonly _slots: {
    guards: GuardSlots<GD>;
    effects: EffectSlots<EFD>;
  };
  readonly stateSchema?: Schema.Schema<State, unknown, never>;
  readonly eventSchema?: Schema.Schema<Event, unknown, never>;

  /**
   * Context tag for accessing machine state/event/self in slot handlers.
   * Uses shared module-level tag for all machines.
   */
  readonly Context: Context.Tag<
    MachineContext<State, Event, MachineRef<Event>>,
    MachineContext<State, Event, MachineRef<Event>>
  > = MachineContextTag as Context.Tag<
    MachineContext<State, Event, MachineRef<Event>>,
    MachineContext<State, Event, MachineRef<Event>>
  >;

  // Public readonly views
  get transitions(): ReadonlyArray<Transition<State, Event, GD, EFD, R>> {
    return this._transitions;
  }
  get spawnEffects(): ReadonlyArray<SpawnEffect<State, Event, EFD, R>> {
    return this._spawnEffects;
  }
  get backgroundEffects(): ReadonlyArray<BackgroundEffect<State, Event, EFD, R>> {
    return this._backgroundEffects;
  }
  get finalStates(): ReadonlySet<string> {
    return this._finalStates;
  }
  get guardsSchema(): GuardsSchema<GD> | undefined {
    return this._guardsSchema;
  }
  get effectsSchema(): EffectsSchema<EFD> | undefined {
    return this._effectsSchema;
  }

  /** @internal */
  constructor(
    initial: State,
    stateSchema?: Schema.Schema<State, unknown, never>,
    eventSchema?: Schema.Schema<Event, unknown, never>,
    guardsSchema?: GuardsSchema<GD>,
    effectsSchema?: EffectsSchema<EFD>,
  ) {
    this.initial = initial;
    this._transitions = [];
    this._spawnEffects = [];
    this._backgroundEffects = [];
    this._finalStates = new Set();
    this._guardsSchema = guardsSchema;
    this._effectsSchema = effectsSchema;
    this._guardHandlers = new Map();
    this._effectHandlers = new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;

    const guardSlots =
      this._guardsSchema !== undefined
        ? this._guardsSchema._createSlots((name: string, params: unknown) =>
            Effect.flatMap(Effect.serviceOptional(this.Context).pipe(Effect.orDie), (ctx) => {
              const handler = this._guardHandlers.get(name);
              if (handler === undefined) {
                return Effect.die(new SlotProvisionError({ slotName: name, slotType: "guard" }));
              }
              const result = handler(params, ctx);
              const normalized = typeof result === "boolean" ? Effect.succeed(result) : result;
              return normalized as Effect.Effect<boolean, never, never>;
            }),
          )
        : ({} as GuardSlots<GD>);

    const effectSlots =
      this._effectsSchema !== undefined
        ? this._effectsSchema._createSlots((name: string, params: unknown) =>
            Effect.flatMap(Effect.serviceOptional(this.Context).pipe(Effect.orDie), (ctx) => {
              const handler = this._effectHandlers.get(name);
              if (handler === undefined) {
                return Effect.die(new SlotProvisionError({ slotName: name, slotType: "effect" }));
              }
              return handler(params, ctx) as Effect.Effect<void, never, never>;
            }),
          )
        : ({} as EffectSlots<EFD>);

    this._slots = { guards: guardSlots, effects: effectSlots };
  }

  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments);
  }

  // ---- on ----

  /** Register transition for a single state */
  on<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  /** Register transition for multiple states (handler receives union of state types) */
  on<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    states: NS,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      NE,
      RS,
      GD,
      EFD,
      never
    >,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(stateOrStates: any, event: any, handler: any): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    for (const s of states) {
      this.addTransition(s, event, handler, false);
    }
    return this;
  }

  // ---- reenter ----

  /**
   * Like `on()`, but forces onEnter/spawn to run even when transitioning to the same state tag.
   * Use this to restart timers, re-run spawned effects, or reset state-scoped effects.
   */
  /** Single state */
  reenter<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  /** Multiple states */
  reenter<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    states: NS,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      NE,
      RS,
      GD,
      EFD,
      never
    >,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reenter(
    stateOrStates: any,
    event: any,
    handler: any,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    for (const s of states) {
      this.addTransition(s, event, handler, true);
    }
    return this;
  }

  // ---- onAny ----

  /**
   * Register a wildcard transition that fires from any state when no specific transition matches.
   * Specific `.on()` transitions always take priority over `.onAny()`.
   */
  onAny<NE extends VariantsUnion<_ED> & BrandedEvent, RS extends VariantsUnion<_SD> & BrandedState>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<VariantsUnion<_SD> & BrandedState, NE, RS, GD, EFD, never>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const eventTag = getTag(event);
    const transition: Transition<State, Event, GD, EFD, R> = {
      stateTag: "*",
      eventTag,
      handler: handler as unknown as Transition<State, Event, GD, EFD, R>["handler"],
      reenter: false,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._transitions as any[]).push(transition);
    invalidateIndex(this);
    return this;
  }

  /** @internal */
  private addTransition<NS extends BrandedState, NE extends BrandedEvent>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, BrandedState, GD, EFD, never>,
    reenter: boolean,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);

    const transition: Transition<State, Event, GD, EFD, R> = {
      stateTag,
      eventTag,
      handler: handler as unknown as Transition<State, Event, GD, EFD, R>["handler"],
      reenter,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._transitions as any[]).push(transition);
    invalidateIndex(this);

    return this;
  }

  // ---- spawn ----

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
   *   .provide({
   *     fetchData: ({ url }, { self }) =>
   *       Effect.gen(function* () {
   *         yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
   *         const data = yield* Http.get(url);
   *         yield* self.send(Event.Loaded({ data }));
   *       }),
   *   });
   * ```
   */
  spawn<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, VariantsUnion<_ED> & BrandedEvent, EFD, Scope.Scope>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._spawnEffects as any[]).push({
      stateTag,
      handler: handler as unknown as SpawnEffect<State, Event, EFD, R>["handler"],
    });
    invalidateIndex(this);
    return this;
  }

  // ---- task ----

  /**
   * State-scoped task that runs on entry and sends success/failure events.
   * Interrupts do not emit failure events.
   */
  task<
    NS extends VariantsUnion<_SD> & BrandedState,
    A,
    E1,
    ES extends VariantsUnion<_ED> & BrandedEvent,
    EF extends VariantsUnion<_ED> & BrandedEvent,
  >(
    state: TaggedOrConstructor<NS>,
    run: (
      ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent, EFD>,
    ) => Effect.Effect<A, E1, Scope.Scope>,
    options: {
      readonly onSuccess: (
        value: A,
        ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent, EFD>,
      ) => ES;
      readonly onFailure?: (
        cause: Cause.Cause<E1>,
        ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent, EFD>,
      ) => EF;
    },
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const handler = Effect.fn("effect-machine.task")(function* (
      ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent, EFD>,
    ) {
      const exit = yield* Effect.exit(run(ctx));
      if (Exit.isSuccess(exit)) {
        yield* ctx.self.send(options.onSuccess(exit.value, ctx));
        yield* Effect.yieldNow();
        return;
      }

      const cause = exit.cause;
      if (Cause.isInterruptedOnly(cause)) {
        return;
      }
      if (options.onFailure !== undefined) {
        yield* ctx.self.send(options.onFailure(cause, ctx));
        yield* Effect.yieldNow();
        return;
      }
      return yield* Effect.failCause(cause).pipe(Effect.orDie);
    });

    return this.spawn(state, handler);
  }

  // ---- background ----

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
   *   .provide({
   *     heartbeat: (_, { self }) =>
   *       Effect.forever(
   *         Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(Event.Ping)))
   *       ),
   *   });
   * ```
   */
  background(
    handler: StateEffectHandler<State, Event, EFD, Scope.Scope>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._backgroundEffects as any[]).push({
      handler: handler as unknown as BackgroundEffect<State, Event, EFD, R>["handler"],
    });
    return this;
  }

  // ---- final ----

  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    this._finalStates.add(stateTag);
    return this;
  }

  // ---- provide ----

  /**
   * Provide implementations for guard and effect slots.
   * Creates a new machine instance (the original can be reused with different providers).
   */
  provide<R2>(
    handlers: ProvideHandlers<State, Event, GD, EFD, R2>,
  ): Machine<State, Event, R | NormalizeR<R2>, _SD, _ED, GD, EFD> {
    // Collect all required slot names in a single pass
    const requiredSlots = new Set<string>();
    if (this._guardsSchema !== undefined) {
      for (const name of Object.keys(this._guardsSchema.definitions)) {
        requiredSlots.add(name);
      }
    }
    if (this._effectsSchema !== undefined) {
      for (const name of Object.keys(this._effectsSchema.definitions)) {
        requiredSlots.add(name);
      }
    }

    // Single-pass validation: collect all missing and extra handlers
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

    // Report all validation errors at once
    if (missing.length > 0 || extra.length > 0) {
      throw new ProvisionValidationError({ missing, extra });
    }

    // Create new machine to preserve original for reuse with different providers
    const result = new Machine<State, Event, R | R2, _SD, _ED, GD, EFD>(
      this.initial,
      this.stateSchema as Schema.Schema<State, unknown, never>,
      this.eventSchema as Schema.Schema<Event, unknown, never>,
      this._guardsSchema,
      this._effectsSchema,
    );

    // Copy arrays/sets to avoid mutation bleed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._transitions = [...this._transitions];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._finalStates = new Set(this._finalStates);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._spawnEffects = [...this._spawnEffects];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._backgroundEffects = [...this._backgroundEffects];

    // Register handlers from provided object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyHandlers = handlers as Record<string, any>;
    if (this._guardsSchema !== undefined) {
      for (const name of Object.keys(this._guardsSchema.definitions)) {
        result._guardHandlers.set(name, anyHandlers[name]);
      }
    }
    if (this._effectsSchema !== undefined) {
      for (const name of Object.keys(this._effectsSchema.definitions)) {
        result._effectHandlers.set(name, anyHandlers[name]);
      }
    }

    return result as unknown as Machine<State, Event, R | NormalizeR<R2>, _SD, _ED, GD, EFD>;
  }

  // ---- persist ----

  persist(
    config: PersistOptions,
  ): PersistentMachine<State & { readonly _tag: string }, Event & { readonly _tag: string }, R> {
    return persistImpl(config as WithPersistenceConfig)(
      this as unknown as Machine<BrandedState, BrandedEvent, R>,
    ) as unknown as PersistentMachine<
      State & { readonly _tag: string },
      Event & { readonly _tag: string },
      R
    >;
  }

  /**
   * Validate all slots are provided. Throws if any missing.
   * Use after `.provide()` for early feedback.
   */
  validate(): this {
    const missing = this._missingSlots();
    if (missing.length > 0) {
      throw new UnprovidedSlotsError({ slots: missing });
    }
    return this;
  }

  /**
   * Missing slot handlers (guards + effects).
   * @internal Used by actor creation to fail fast.
   */
  _missingSlots(): string[] {
    const missing: string[] = [];
    if (this._guardsSchema !== undefined) {
      for (const name of Object.keys(this._guardsSchema.definitions)) {
        if (!this._guardHandlers.has(name)) missing.push(name);
      }
    }
    if (this._effectsSchema !== undefined) {
      for (const name of Object.keys(this._effectsSchema.definitions)) {
        if (!this._effectHandlers.has(name)) missing.push(name);
      }
    }
    return missing;
  }

  // ---- Static factory ----

  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(config: MakeConfig<SD, ED, S, E, GD, EFD>): Machine<S, E, never, SD, ED, GD, EFD> {
    return new Machine<S, E, never, SD, ED, GD, EFD>(
      config.initial,
      config.state as unknown as Schema.Schema<S, unknown, never>,
      config.event as unknown as Schema.Schema<E, unknown, never>,
      config.guards as GuardsSchema<GD> | undefined,
      config.effects as EffectsSchema<EFD> | undefined,
    );
  }
}

// ============================================================================
// make function (alias for Machine.make)
// ============================================================================

export const make = Machine.make;

// ============================================================================
// spawn function - simple actor creation without ActorSystem
// ============================================================================

import type { ActorRef } from "./actor.js";
import { createActor } from "./actor.js";

/**
 * Spawn an actor directly without ActorSystem ceremony.
 *
 * Use this for simple single-actor cases. For registry, persistence, or
 * multi-actor coordination, use ActorSystemService instead.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const actor = yield* Machine.spawn(machine);
 *   yield* actor.send(Event.Start);
 *   yield* Effect.yieldNow();
 *   return yield* actor.snapshot;
 * });
 *
 * Effect.runPromise(Effect.scoped(program));
 * ```
 */
const spawnImpl = Effect.fn("effect-machine.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
  machine: Machine<S, E, R, any, any, GD, EFD>,
  id?: string,
) {
  const actorId = id ?? `actor-${Math.random().toString(36).slice(2)}`;
  const actor = yield* createActor(actorId, machine);

  // Register cleanup on scope finalization
  yield* Effect.addFinalizer(
    Effect.fn("effect-machine.spawn.finalizer")(function* () {
      yield* actor.stop;
    }),
  );

  return actor;
});

export const spawn: {
  <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef,
    EFD extends EffectsDef,
  >(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
    machine: Machine<S, E, R, any, any, GD, EFD>,
  ): Effect.Effect<ActorRef<S, E>, UnprovidedSlotsError, R | Scope.Scope>;

  <
    S extends { readonly _tag: string },
    E extends { readonly _tag: string },
    R,
    GD extends GuardsDef,
    EFD extends EffectsDef,
  >(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Schema fields need wide acceptance
    machine: Machine<S, E, R, any, any, GD, EFD>,
    id: string,
  ): Effect.Effect<ActorRef<S, E>, UnprovidedSlotsError, R | Scope.Scope>;
} = spawnImpl;

// Transition lookup (introspection)
export { findTransitions } from "./internal/transition.js";

// Persistence types
export type { PersistenceConfig, PersistentMachine } from "./persistence/index.js";
