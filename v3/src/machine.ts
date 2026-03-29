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
 *   .build({
 *     canStart: ({ threshold }) => Effect.succeed(threshold > 0),
 *     notify: ({ message }) => Effect.log(message),
 *   })
 * ```
 *
 * @module
 */
import type { Schema, Context, Duration } from "effect";
import { Cause, Effect, Exit, Option, Scope } from "effect";

import type { Supervision } from "./supervision.js";

import type { TransitionResult, ReplyResult } from "./internal/utils.js";
import { getTag, stubSystem, makeReply } from "./internal/utils.js";
import type {
  TaggedOrConstructor,
  BrandedState,
  BrandedEvent,
  ExtractReply,
} from "./internal/brands.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./schema.js";
import { SlotProvisionError, ProvisionValidationError } from "./errors.js";
import type { DuplicateActorError } from "./errors.js";
import {
  invalidateIndex,
  resolveTransition,
  runTransitionHandler,
  shouldPostpone,
} from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import type { ActorRef, ActorSystem } from "./actor.js";
import { Inspector as InspectorTag } from "./inspection.js";
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
  /** Fire-and-forget alias for send (OTP gen_server:cast). */
  readonly cast: (event: Event) => Effect.Effect<void>;
  readonly spawn: <S2 extends { readonly _tag: string }, E2 extends { readonly _tag: string }, R2>(
    id: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S2, E2, R2, any, any, any, any>,
  ) => Effect.Effect<ActorRef<S2, E2>, DuplicateActorError, R2>;
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
  readonly actorId: string;
  readonly state: State;
  readonly event: Event;
  readonly self: MachineRef<Event>;
  readonly effects: EffectSlots<ED>;
  readonly system: ActorSystem;
}

/**
 * Transition handler function.
 * When Reply is concrete (event has a reply schema), handler must return Machine.reply().
 * When Reply is never, handler returns plain state.
 */
export type TransitionHandler<
  S,
  E,
  NewState,
  GD extends GuardsDef,
  ED extends EffectsDef,
  R,
  Reply = never,
> = (ctx: HandlerContext<S, E, GD, ED>) => TransitionResult<NewState, R, Reply>;

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

export interface TaskOptions<State, Event, ED extends EffectsDef, A, E1, ES, EF> {
  readonly onSuccess: (value: A, ctx: StateHandlerContext<State, Event, ED>) => ES;
  readonly onFailure?: (cause: Cause.Cause<E1>, ctx: StateHandlerContext<State, Event, ED>) => EF;
  readonly name?: string;
}

/**
 * Configuration for `.timeout()` — gen_statem-style state timeouts.
 *
 * Entering the state starts a timer. Leaving cancels it.
 * `.reenter()` restarts the timer with fresh state values.
 */
export interface TimeoutConfig<State, Event> {
  /** Duration before firing. Static or derived from current state. */
  readonly duration: Duration.DurationInput | ((state: State) => Duration.DurationInput);
  /** Event to send when the timer fires. Static or derived from current state. */
  readonly event: Event | ((state: State) => Event);
}

// ============================================================================
// Internal helpers
// ============================================================================

const emitTaskInspection = <S extends { readonly _tag: string }>(input: {
  readonly actorId: string;
  readonly state: S;
  readonly taskName: string | undefined;
  readonly phase: "start" | "success" | "failure" | "interrupt";
  readonly error?: string;
}) =>
  Effect.flatMap(Effect.serviceOptional(InspectorTag).pipe(Effect.option), (inspector) =>
    Option.isNone(inspector)
      ? Effect.void
      : emitWithTimestamp(inspector.value, (timestamp) => ({
          type: "@machine.task" as const,
          actorId: input.actorId,
          state: input.state,
          taskName: input.taskName,
          phase: input.phase,
          error: input.error,
          timestamp,
        })),
  );

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

/** Combined handlers for build() - guards and effects only */
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
// materializeMachine — internal slot binding at execution boundaries
// ============================================================================

/**
 * Bind slot handlers to a machine, returning a fresh copy with handlers installed.
 * If no handlers provided and machine has no slots, returns the machine as-is.
 * Validates that all required slots are provided and no extra slots are given.
 *
 * @internal — used by spawn, replay, simulate, test harness, entity-machine
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const materializeMachine = <S, E, R, GD extends GuardsDef, EFD extends EffectsDef>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any, GD, EFD>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlers?: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Machine<S, E, never, any, any, GD, EFD> => {
  if (handlers === undefined) {
    // Validate: slot-free machines can skip handlers, slotful machines must provide them
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return machine as any;
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

  // Create fresh copy to avoid mutation bleed between actors
  const result = new Machine<
    S,
    E,
    never,
    Record<string, Schema.Struct.Fields>,
    Record<string, Schema.Struct.Fields>,
    GD,
    EFD
  >(
    machine.initial,
    machine.stateSchema as Schema.Schema<S, unknown, never>,
    machine.eventSchema as Schema.Schema<E, unknown, never>,
    machine._guardsSchema,
    machine._effectsSchema,
  );

  // Copy arrays/sets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._transitions = [...machine._transitions];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._finalStates = new Set(machine._finalStates);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._spawnEffects = [...machine._spawnEffects];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._backgroundEffects = [...machine._backgroundEffects];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._postponeRules = [...machine._postponeRules];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (result as any)._replySchemas = machine._replySchemas;

  // Register handlers
  if (machine._guardsSchema !== undefined) {
    for (const name of Object.keys(machine._guardsSchema.definitions)) {
      result._guardHandlers.set(name, handlers[name]);
    }
  }
  if (machine._effectsSchema !== undefined) {
    for (const name of Object.keys(machine._effectsSchema.definitions)) {
      result._effectHandlers.set(name, handlers[name]);
    }
  }

  return result;
};

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
> {
  readonly initial: State;
  /** @internal */ readonly _transitions: Array<Transition<State, Event, GD, EFD, R>>;
  /** @internal */ readonly _spawnEffects: Array<SpawnEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _backgroundEffects: Array<BackgroundEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _finalStates: Set<string>;
  /** @internal */ readonly _postponeRules: Array<{
    readonly stateTag: string;
    readonly eventTag: string;
  }>;
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
  /** @internal */ readonly _replySchemas: ReadonlyMap<string, Schema.Schema.Any>;

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
  get postponeRules(): ReadonlyArray<{ readonly stateTag: string; readonly eventTag: string }> {
    return this._postponeRules;
  }
  get guardsSchema(): GuardsSchema<GD> | undefined {
    return this._guardsSchema;
  }
  get effectsSchema(): EffectsSchema<EFD> | undefined {
    return this._effectsSchema;
  }
  get replySchemas(): ReadonlyMap<string, Schema.Schema.Any> {
    return this._replySchemas;
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
    this._postponeRules = [];
    this._guardsSchema = guardsSchema;
    this._effectsSchema = effectsSchema;
    this._guardHandlers = new Map();
    this._effectHandlers = new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._replySchemas = (eventSchema as any)?._replySchemas ?? new Map();

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

  // ---- on ----

  from<NS extends VariantsUnion<_SD> & BrandedState, R1>(
    state: TaggedOrConstructor<NS>,
    build: (scope: TransitionScope<State, Event, R, _SD, _ED, GD, EFD, NS>) => R1,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  from<NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>, R1>(
    states: NS,
    build: (
      scope: TransitionScope<
        State,
        Event,
        R,
        _SD,
        _ED,
        GD,
        EFD,
        NS[number] extends TaggedOrConstructor<infer S extends VariantsUnion<_SD> & BrandedState>
          ? S
          : never
      >,
    ) => R1,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  from(
    stateOrStates:
      | TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>
      | ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    build: (
      scope: TransitionScope<State, Event, R, _SD, _ED, GD, EFD, VariantsUnion<_SD> & BrandedState>,
    ) => unknown,
  ) {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    build(new TransitionScope(this, states));
    return this;
  }

  /** @internal */
  scopeTransition<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    states: ReadonlyArray<TaggedOrConstructor<NS>>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never, ExtractReply<NE>>,
    reenter: boolean,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    for (const state of states) {
      this.addTransition(
        state,
        event,
        handler as TransitionHandler<NS, NE, BrandedState, GD, EFD, never>,
        reenter,
      );
    }
    return this;
  }

  /** Register transition for a single state */
  on<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never, ExtractReply<NE>>,
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
      never,
      ExtractReply<NE>
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
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never, ExtractReply<NE>>,
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
      never,
      ExtractReply<NE>
    >,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  reenter(
    stateOrStates: any,
    event: any,
    handler: any,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    /* eslint-enable @typescript-eslint/no-explicit-any */
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
    options: TaskOptions<NS, VariantsUnion<_ED> & BrandedEvent, EFD, A, E1, ES, EF>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const handler = Effect.fn("effect-machine.task")(function* (
      ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent, EFD>,
    ) {
      yield* emitTaskInspection({
        actorId: ctx.actorId,
        state: ctx.state,
        taskName: options.name,
        phase: "start",
      });

      const exit = yield* Effect.exit(run(ctx));

      if (Exit.isSuccess(exit)) {
        yield* emitTaskInspection({
          actorId: ctx.actorId,
          state: ctx.state,
          taskName: options.name,
          phase: "success",
        });
        yield* ctx.self.send(options.onSuccess(exit.value, ctx));
        yield* Effect.yieldNow();
        return;
      }

      const cause = exit.cause;
      if (Cause.isInterruptedOnly(cause)) {
        yield* emitTaskInspection({
          actorId: ctx.actorId,
          state: ctx.state,
          taskName: options.name,
          phase: "interrupt",
        });
        return;
      }
      yield* emitTaskInspection({
        actorId: ctx.actorId,
        state: ctx.state,
        taskName: options.name,
        phase: "failure",
        error: Cause.pretty(cause),
      });
      if (options.onFailure !== undefined) {
        yield* ctx.self.send(options.onFailure(cause, ctx));
        yield* Effect.yieldNow();
        return;
      }
      return yield* Effect.failCause(cause).pipe(Effect.orDie);
    });

    return this.spawn(state, handler);
  }

  // ---- timeout ----

  /**
   * State timeout — gen_statem's `state_timeout`.
   *
   * Entering the state starts a timer. Leaving cancels it (via state scope).
   * `.reenter()` restarts the timer with fresh state values.
   * Compiles to `.task()` internally — preserves `@machine.task` inspection events.
   *
   * @example
   * ```ts
   * machine
   *   .timeout(State.Loading, {
   *     duration: Duration.seconds(30),
   *     event: Event.Timeout,
   *   })
   *   // Dynamic duration from state
   *   .timeout(State.Retrying, {
   *     duration: (state) => Duration.seconds(state.backoff),
   *     event: Event.GiveUp,
   *   })
   * ```
   */
  timeout<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
    config: TimeoutConfig<NS, VariantsUnion<_ED> & BrandedEvent>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    const resolveDuration =
      typeof config.duration === "function"
        ? (config.duration as (state: NS) => Duration.DurationInput)
        : () => config.duration as Duration.DurationInput;
    const resolveEvent =
      typeof config.event === "function"
        ? (config.event as (state: NS) => VariantsUnion<_ED> & BrandedEvent)
        : () => config.event as VariantsUnion<_ED> & BrandedEvent;

    return this.task(state, (ctx) => Effect.sleep(resolveDuration(ctx.state)), {
      onSuccess: (_, ctx) => resolveEvent(ctx.state),
      name: `$timeout:${stateTag}`,
    });
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
   *   .build({
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

  // ---- postpone ----

  /**
   * Postpone events — gen_statem's event postpone.
   *
   * When a matching event arrives in the given state, it is buffered instead of
   * processed. After the next state transition (tag change), all buffered events
   * are drained through the loop in FIFO order.
   *
   * Reply-bearing events (from `call`/`ask`) in the postpone buffer are settled
   * with `ActorStoppedError` on stop/interrupt/final-state.
   *
   * @example
   * ```ts
   * machine
   *   .postpone(State.Connecting, Event.Data)           // single event
   *   .postpone(State.Connecting, [Event.Data, Event.Cmd]) // multiple events
   * ```
   */
  postpone<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
    events:
      | TaggedOrConstructor<VariantsUnion<_ED> & BrandedEvent>
      | ReadonlyArray<TaggedOrConstructor<VariantsUnion<_ED> & BrandedEvent>>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    const eventList = Array.isArray(events) ? events : [events];
    for (const ev of eventList) {
      const eventTag = getTag(ev);
      this._postponeRules.push({ stateTag, eventTag });
    }
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

class TransitionScope<
  State,
  Event,
  R,
  _SD extends Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef,
  EFD extends EffectsDef,
  SelectedState extends VariantsUnion<_SD> & BrandedState,
> {
  constructor(
    private readonly machine: Machine<State, Event, R, _SD, _ED, GD, EFD>,
    private readonly states: ReadonlyArray<TaggedOrConstructor<SelectedState>>,
  ) {}

  on<NE extends VariantsUnion<_ED> & BrandedEvent, RS extends VariantsUnion<_SD> & BrandedState>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, GD, EFD, never, ExtractReply<NE>>,
  ): TransitionScope<State, Event, R, _SD, _ED, GD, EFD, SelectedState> {
    this.machine.scopeTransition(this.states, event, handler, false);
    return this;
  }

  reenter<
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, GD, EFD, never, ExtractReply<NE>>,
  ): TransitionScope<State, Event, R, _SD, _ED, GD, EFD, SelectedState> {
    this.machine.scopeTransition(this.states, event, handler, true);
    return this;
  }
}

// ============================================================================
// make function (alias for Machine.make)
// ============================================================================

export const make = Machine.make;

// ============================================================================
// spawn function - simple actor creation without ActorSystem
// ============================================================================

import { createActor } from "./actor.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMachine<S, E, R> = Machine<S, E, R, any, any, any, any>;

/**
 * Spawn an actor directly without ActorSystem ceremony.
 *
 * **Single actor, no registry.** Caller manages lifetime via `actor.stop`.
 * If a `Scope` exists in context, cleanup attaches automatically on scope close.
 *
 * For registry, lookup by ID, or multi-actor coordination,
 * use `ActorSystemService` / `system.spawn` instead.
 *
 * @example
 * ```ts
 * // Fire-and-forget — caller manages lifetime
 * const actor = yield* Machine.spawn(machine);
 * yield* actor.send(Event.Start);
 * yield* actor.awaitFinal;
 * yield* actor.stop;
 *
 * // Scope-aware — auto-cleans up on scope close
 * yield* Effect.scoped(Effect.gen(function* () {
 *   const actor = yield* Machine.spawn(machine);
 *   yield* actor.send(Event.Start);
 *   // actor.stop called automatically when scope closes
 * }));
 *
 * // With slots
 * const actor = yield* Machine.spawn(machine, {
 *   slots: { fetchData: ({ url }) => Http.get(url) },
 * });
 * ```
 */
const spawnImpl = Effect.fn("effect-machine.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: AnyMachine<S, E, R>,
  options?:
    | string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { id?: string; hydrate?: S; slots?: Record<string, any>; supervision?: Supervision.Policy },
) {
  const opts = typeof options === "string" ? { id: options } : options;
  const actorId = opts?.id ?? `actor-${Math.random().toString(36).slice(2)}`;
  const materialized = materializeMachine(machine, opts?.slots);
  const actor = yield* createActor(actorId, materialized as AnyMachine<S, E, never>, {
    initialState: opts?.hydrate,
    supervision: opts?.supervision,
  });

  // If a scope exists in context, attach cleanup automatically
  const maybeScope = yield* Effect.serviceOption(Scope.Scope);
  if (Option.isSome(maybeScope)) {
    yield* Scope.addFinalizer(maybeScope.value, actor.stop);
  }

  return actor;
});

/**
 * Spawn an actor from a machine.
 *
 * Options:
 * - `id` — custom actor ID (default: random)
 * - `hydrate` — restore from a previously-saved state snapshot.
 * - `slots` — slot handler implementations for slotful machines.
 */
export const spawn: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: AnyMachine<S, E, R>,
  options?:
    | string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { id?: string; hydrate?: S; slots?: Record<string, any>; supervision?: Supervision.Policy },
) => Effect.Effect<ActorRef<S, E>, never, R> = spawnImpl;

/**
 * Replay events through a machine to compute the final state.
 *
 * Folds events through transition handlers — the same state computation
 * that runs in a live actor, minus runtime side effects:
 * - Transition handlers run (pure or effectful — they compute state)
 * - `self.send`/`self.spawn` are no-ops (stubbed)
 * - Spawn effects, background effects, and timeouts do NOT run
 * - Postpone rules are respected (postponed events drain on state change)
 * - Final states stop replay (remaining events ignored)
 * - Unhandled events are silently skipped (matches live actor behavior)
 *
 * Use `from` to replay from a snapshot midpoint instead of the machine's initial state.
 *
 * @example
 * ```ts
 * // Restore from event log
 * const state = yield* Machine.replay(machine, savedEvents);
 * const actor = yield* Machine.spawn(machine, { hydrate: state });
 *
 * // Restore from snapshot + tail events
 * const state = yield* Machine.replay(machine, tailEvents, { from: snapshot });
 * const actor = yield* Machine.spawn(machine, { hydrate: state });
 * ```
 */
const replayImpl = Effect.fn("effect-machine.replay")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  input: AnyMachine<S, E, R>,
  events: ReadonlyArray<E>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { from?: S; slots?: Record<string, any> },
) {
  const machine = materializeMachine(input, options?.slots);
  let state: S = options?.from ?? machine.initial;

  const hasPostponeRules = machine.postponeRules.length > 0;
  const postponed: E[] = [];

  const dummySend = Effect.fn("effect-machine.replay.send")((_event: E) => Effect.void);
  const self: MachineRef<E> = {
    send: dummySend,
    cast: dummySend,
    spawn: () => Effect.die("spawn not supported in replay"),
  };

  for (const event of events) {
    // Final state stops replay
    if (machine.finalStates.has(state._tag)) break;

    // Check postpone rules
    if (hasPostponeRules && shouldPostpone(machine, state._tag, event._tag)) {
      postponed.push(event);
      continue;
    }

    const transition = resolveTransition(machine, state, event);
    if (transition !== undefined) {
      const result = yield* runTransitionHandler(
        machine,
        transition,
        state,
        event,
        self,
        stubSystem,
        "replay",
      );
      const previousTag = state._tag;
      state = result.newState;

      // Drain postponed events on state change — loop until stable
      const stateChanged = state._tag !== previousTag || transition.reenter === true;
      if (stateChanged && postponed.length > 0) {
        let drainTag = previousTag;
        while (state._tag !== drainTag && postponed.length > 0) {
          if (machine.finalStates.has(state._tag)) break;
          drainTag = state._tag;
          const drained = postponed.splice(0);
          for (const postponedEvent of drained) {
            if (machine.finalStates.has(state._tag)) break;
            if (shouldPostpone(machine, state._tag, postponedEvent._tag)) {
              postponed.push(postponedEvent);
              continue;
            }
            const pTransition = resolveTransition(machine, state, postponedEvent);
            if (pTransition !== undefined) {
              const pResult = yield* runTransitionHandler(
                machine,
                pTransition,
                state,
                postponedEvent,
                self,
                stubSystem,
                "replay",
              );
              state = pResult.newState;
            }
          }
        }
      }
    }
  }

  return state;
});

export const replay: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  machine: AnyMachine<S, E, R>,
  events: ReadonlyArray<E>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options?: { from?: S; slots?: Record<string, any> },
) => Effect.Effect<S, never, R> = replayImpl;

// Reply helper
export const reply = makeReply;
export type { ReplyResult } from "./internal/utils.js";

// Transition lookup (introspection)
export { findTransitions } from "./internal/transition.js";
