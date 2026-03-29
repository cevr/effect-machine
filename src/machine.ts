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
 *
 * // Spawn with slot implementations
 * const actor = yield* Machine.spawn(machine, {
 *   slots: {
 *     canStart: ({ threshold }) => Effect.succeed(threshold > 0),
 *     notify: ({ message }) => Effect.log(message),
 *   },
 * })
 * ```
 *
 * @module
 */
import type { Schema, ServiceMap, Duration } from "effect";
import { Cause, Effect, Exit, Option, Random, Scope } from "effect";

import type { TransitionResult, ReplyResult } from "./internal/utils.js";
import { getTag, stubSystem, makeReply, makeDeferReply } from "./internal/utils.js";
import { validateSlots } from "./internal/slots.js";
import type {
  TaggedOrConstructor,
  BrandedState,
  BrandedEvent,
  ExtractReply,
} from "./internal/brands.js";
import type { MachineStateSchema, MachineEventSchema } from "./schema.js";
import { SlotProvisionError } from "./errors.js";
import type { DuplicateActorError } from "./errors.js";
import { invalidateIndex } from "./internal/transition.js";
import { foldEvents } from "./internal/fold.js";
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
    machine: Machine<S2, E2, R2, any, any>,
  ) => Effect.Effect<ActorRef<S2, E2>, DuplicateActorError, R2>;
  /**
   * Settle a deferred reply from a spawn handler.
   * Only usable when the transition handler returned `Machine.deferReply(state)`.
   * Returns true if a pending reply was settled, false if none was pending.
   */
  readonly reply: (value: unknown) => Effect.Effect<boolean>;
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
  readonly duration: Duration.Input | ((state: State) => Duration.Input);
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
  Effect.flatMap(Effect.serviceOption(InspectorTag), (inspector) =>
    Option.isNone(inspector)
      ? Effect.void
      : emitWithTimestamp(inspector.value, (timestamp) => ({
          type: "@machine.task",
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

// Re-export validateSlots from internal module (avoids circular dependency with actor.ts)
export { validateSlots } from "./internal/slots.js";

// ============================================================================
// Machine class
// ============================================================================

/**
 * Machine definition with fluent builder API.
 *
 * Type parameters:
 * - `State`: The state union type (branded with schema definition shape)
 * - `Event`: The event union type (branded with schema definition shape)
 * - `R`: Effect requirements
 * - `GD`: Guard definitions
 * - `EFD`: Effect definitions
 */
export class Machine<
  State extends { readonly _tag: string },
  Event extends { readonly _tag: string },
  R = never,
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
  /** @internal */ readonly _slots: {
    guards: GuardSlots<GD>;
    effects: EffectSlots<EFD>;
  };
  readonly stateSchema?: Schema.Schema<State>;
  readonly eventSchema?: Schema.Schema<Event>;
  /** @internal */ readonly _replySchemas: ReadonlyMap<string, Schema.Decoder<unknown>>;

  /**
   * Context tag for accessing machine state/event/self in slot handlers.
   * Uses shared module-level tag for all machines.
   */
  readonly Context: ServiceMap.Service<
    MachineContext<State, Event, MachineRef<Event>>,
    MachineContext<State, Event, MachineRef<Event>>
  > = MachineContextTag as ServiceMap.Service<
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
  get replySchemas(): ReadonlyMap<string, Schema.Decoder<unknown>> {
    return this._replySchemas;
  }

  /** @internal */
  constructor(
    initial: State,
    stateSchema?: Schema.Schema<State>,
    eventSchema?: Schema.Schema<Event>,
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._replySchemas = (eventSchema as any)?._replySchemas ?? new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;

    const guardSlots =
      this._guardsSchema !== undefined
        ? this._guardsSchema._createSlots((name: string, params: unknown) =>
            Effect.flatMap(Effect.serviceOption(this.Context), (maybeCtx) => {
              if (Option.isNone(maybeCtx)) {
                return Effect.die("MachineContext not available");
              }
              const ctx = maybeCtx.value;
              const handler = ctx._slotHandlers?.get(name);
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
            Effect.flatMap(Effect.serviceOption(this.Context), (maybeCtx) => {
              if (Option.isNone(maybeCtx)) {
                return Effect.die("MachineContext not available");
              }
              const ctx = maybeCtx.value;
              const handler = ctx._slotHandlers?.get(name);
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

  /** Register transition for a single state */
  on<NS extends State, NE extends Event, RS extends State>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never, ExtractReply<NE>>,
  ): Machine<State, Event, R, GD, EFD>;
  /** Register transition for multiple states (handler receives union of state types) */
  on<NS extends ReadonlyArray<TaggedOrConstructor<State>>, NE extends Event, RS extends State>(
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
  ): Machine<State, Event, R, GD, EFD>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(stateOrStates: any, event: any, handler: any): Machine<State, Event, R, GD, EFD> {
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
  reenter<NS extends State, NE extends Event, RS extends State>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, never, ExtractReply<NE>>,
  ): Machine<State, Event, R, GD, EFD>;
  /** Multiple states */
  reenter<NS extends ReadonlyArray<TaggedOrConstructor<State>>, NE extends Event, RS extends State>(
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
  ): Machine<State, Event, R, GD, EFD>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  reenter(stateOrStates: any, event: any, handler: any): Machine<State, Event, R, GD, EFD> {
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
  onAny<NE extends Event, RS extends State>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<State, NE, RS, GD, EFD, never>,
  ): Machine<State, Event, R, GD, EFD> {
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
  private addTransition<NS extends { readonly _tag: string }, NE extends { readonly _tag: string }>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: any,
    reenter: boolean,
  ): Machine<State, Event, R, GD, EFD> {
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
  /** Single state */
  spawn<NS extends State>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, Event, EFD, Scope.Scope>,
  ): Machine<State, Event, R, GD, EFD>;
  /** Multiple states */
  spawn<NS extends ReadonlyArray<TaggedOrConstructor<State>>>(
    states: NS,
    handler: StateEffectHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      Event,
      EFD,
      Scope.Scope
    >,
  ): Machine<State, Event, R, GD, EFD>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawn(stateOrStates: any, handler: any): Machine<State, Event, R, GD, EFD> {
    const states = Array.isArray(stateOrStates) ? stateOrStates : [stateOrStates];
    for (const s of states) {
      const stateTag = getTag(s);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._spawnEffects as any[]).push({
        stateTag,
        handler: handler as unknown as SpawnEffect<State, Event, EFD, R>["handler"],
      });
    }
    invalidateIndex(this);
    return this;
  }

  // ---- task ----

  /**
   * State-scoped task that runs on entry and sends success/failure events.
   * Interrupts do not emit failure events.
   */
  /** Task with explicit onSuccess mapping — single state */
  task<NS extends State, A, E1, ES extends Event, EF extends Event>(
    state: TaggedOrConstructor<NS>,
    run: (ctx: StateHandlerContext<NS, Event, EFD>) => Effect.Effect<A, E1, Scope.Scope>,
    options: TaskOptions<NS, Event, EFD, A, E1, ES, EF>,
  ): Machine<State, Event, R, GD, EFD>;
  /** Task with explicit onSuccess mapping — multiple states */
  task<
    NS extends ReadonlyArray<TaggedOrConstructor<State>>,
    A,
    E1,
    ES extends Event,
    EF extends Event,
  >(
    states: NS,
    run: (
      ctx: StateHandlerContext<
        NS[number] extends TaggedOrConstructor<infer S> ? S : never,
        Event,
        EFD
      >,
    ) => Effect.Effect<A, E1, Scope.Scope>,
    options: TaskOptions<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      Event,
      EFD,
      A,
      E1,
      ES,
      EF
    >,
  ): Machine<State, Event, R, GD, EFD>;
  /** Shorthand: when task returns Event directly, onSuccess can be omitted — single state */
  task<NS extends State, E1, EF extends Event>(
    state: TaggedOrConstructor<NS>,
    run: (ctx: StateHandlerContext<NS, Event, EFD>) => Effect.Effect<Event, E1, Scope.Scope>,
    options: {
      onFailure?: (cause: Cause.Cause<E1>, ctx: StateHandlerContext<NS, Event, EFD>) => EF;
      name?: string;
    },
  ): Machine<State, Event, R, GD, EFD>;
  /** Shorthand: when task returns Event directly — multiple states */
  task<NS extends ReadonlyArray<TaggedOrConstructor<State>>, E1, EF extends Event>(
    states: NS,
    run: (
      ctx: StateHandlerContext<
        NS[number] extends TaggedOrConstructor<infer S> ? S : never,
        Event,
        EFD
      >,
    ) => Effect.Effect<Event, E1, Scope.Scope>,
    options: {
      onFailure?: (
        cause: Cause.Cause<E1>,
        ctx: StateHandlerContext<
          NS[number] extends TaggedOrConstructor<infer S> ? S : never,
          Event,
          EFD
        >,
      ) => EF;
      name?: string;
    },
  ): Machine<State, Event, R, GD, EFD>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task(stateOrStates: any, run: any, options: any): Machine<State, Event, R, GD, EFD> {
    const handler = Effect.fn("effect-machine.task")(function* (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: StateHandlerContext<any, Event, EFD>,
    ) {
      yield* emitTaskInspection({
        actorId: ctx.actorId,
        state: ctx.state,
        taskName: options.name,
        phase: "start",
      });

      // @effect-diagnostics anyUnknownInErrorContext:off
      const exit = yield* Effect.exit(run(ctx));

      if (Exit.isSuccess(exit)) {
        yield* emitTaskInspection({
          actorId: ctx.actorId,
          state: ctx.state,
          taskName: options.name,
          phase: "success",
        });
        const successEvent =
          options.onSuccess !== undefined ? options.onSuccess(exit.value, ctx) : exit.value;
        yield* ctx.self.send(successEvent);
        yield* Effect.yieldNow;
        return;
      }

      const cause = exit.cause;
      if (Cause.hasInterruptsOnly(cause)) {
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
        yield* Effect.yieldNow;
        return;
      }
      return yield* Effect.failCause(cause).pipe(Effect.orDie);
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.spawn(stateOrStates, handler as any);
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
  timeout<NS extends State>(
    state: TaggedOrConstructor<NS>,
    config: TimeoutConfig<NS, Event>,
  ): Machine<State, Event, R, GD, EFD> {
    const stateTag = getTag(state);
    const resolveDuration =
      typeof config.duration === "function"
        ? (config.duration as (state: NS) => Duration.Input)
        : () => config.duration as Duration.Input;
    const resolveEvent =
      typeof config.event === "function"
        ? (config.event as (state: NS) => Event)
        : () => config.event as Event;

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
  ): Machine<State, Event, R, GD, EFD> {
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
  postpone<NS extends State>(
    state: TaggedOrConstructor<NS>,
    events: TaggedOrConstructor<Event> | ReadonlyArray<TaggedOrConstructor<Event>>,
  ): Machine<State, Event, R, GD, EFD> {
    const stateTag = getTag(state);
    const eventList = Array.isArray(events) ? events : [events];
    for (const ev of eventList) {
      const eventTag = getTag(ev);
      this._postponeRules.push({ stateTag, eventTag });
    }
    return this;
  }

  // ---- final ----

  final<NS extends State>(state: TaggedOrConstructor<NS>): Machine<State, Event, R, GD, EFD> {
    const stateTag = getTag(state);
    this._finalStates.add(stateTag);
    return this;
  }

  // ---- build ----

  // ---- Static factory ----

  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(config: MakeConfig<SD, ED, S, E, GD, EFD>): Machine<S, E, never, GD, EFD> {
    return new Machine<S, E, never, GD, EFD>(
      config.initial,
      config.state as unknown as Schema.Schema<S>,
      config.event as unknown as Schema.Schema<E>,
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

import { createActor } from "./actor.js";
import type { Supervision } from "./supervision.js";

/**
 * Spawn an actor directly without ActorSystem ceremony.
 * Accepts a `Machine` directly. For slotful machines, pass `{ slots }` in options.
 *
 * **Single actor, no registry.** Caller manages lifetime via `actor.stop`.
 * If a `Scope` exists in context, cleanup attaches automatically on scope close.
 *
 * For registry, lookup by ID, persistence, or multi-actor coordination,
 * use `ActorSystemService` / `system.spawn` instead.
 *
 * @example
 * ```ts
 * // Fire-and-forget — caller manages lifetime
 * const actor = yield* Machine.spawn(machine.build());
 * yield* actor.send(Event.Start);
 * yield* actor.awaitFinal;
 * yield* actor.stop;
 *
 * // Scope-aware — auto-cleans up on scope close
 * yield* Effect.scoped(Effect.gen(function* () {
 *   const actor = yield* Machine.spawn(machine.build());
 *   yield* actor.send(Event.Start);
 *   // actor.stop called automatically when scope closes
 * }));
 * ```
 */
type AnyMachine<
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
> = Machine<S, E, R, any, any>;

const spawnImpl = Effect.fn("effect-machine.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: AnyMachine<S, E, R>,
  idOrOptions?:
    | string
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    | { id?: string; hydrate?: S; slots?: Record<string, any>; supervision?: Supervision.Policy },
) {
  const opts = typeof idOrOptions === "string" ? { id: idOrOptions } : idOrOptions;
  const actorId = opts?.id ?? `actor-${(yield* Random.next).toString(36).slice(2)}`;
  const slotHandlers = validateSlots(machine, opts?.slots);
  const actor = yield* createActor(actorId, machine as AnyMachine<S, E, never>, {
    initialState: opts?.hydrate,
    supervision: opts?.supervision,
    slotHandlers,
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
 * For machines with slots, pass implementations via `{ slots: { ... } }`.
 *
 * @example
 * ```ts
 * // No slots
 * const actor = yield* Machine.spawn(machine);
 *
 * // With slots
 * const actor = yield* Machine.spawn(machine, {
 *   slots: { canRetry: ({ max }, { state }) => state.attempts < max },
 * });
 *
 * // With hydration
 * const actor = yield* Machine.spawn(machine, { hydrate: savedState });
 * ```
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
  const slotHandlers = validateSlots(input, options?.slots);
  const initialState = options?.from ?? input.initial;

  const dummySend = Effect.fn("effect-machine.replay.send")((_event: E) => Effect.void);
  const self: MachineRef<E> = {
    send: dummySend,
    cast: dummySend,
    spawn: () => Effect.die("spawn not supported in replay"),
    reply: () => Effect.succeed(false),
  };

  const { finalState } = yield* foldEvents(
    input,
    initialState,
    events,
    self,
    stubSystem,
    "replay",
    slotHandlers,
  );
  return finalState;
});

export const replay: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    machine: AnyMachine<S, E, R>,
    events: ReadonlyArray<E>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: { from?: S; slots?: Record<string, any> },
  ): Effect.Effect<S, never, R>;
} = replayImpl;

// Transition lookup (introspection)
export { findTransitions } from "./internal/transition.js";

// Reply helpers
export const reply = makeReply;
export const deferReply = makeDeferReply;
export type { ReplyResult, DeferReplyResult } from "./internal/utils.js";

// Supervision (Machine.supervise) deferred to a dedicated PR — requires
// deeper integration with the runtime kernel for defect detection and
// restart semantics that don't fit cleanly into the current ActorRef surface.
