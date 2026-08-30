/**
 * Machine namespace - fluent builder API for state machines.
 *
 * @example
 * ```ts
 * import { Context, Effect, Layer, Schema } from "effect"
 * import { Machine, State, Event } from "effect-machine"
 *
 * const MyState = State({ Idle: {}, Running: {}, Done: { count: Schema.Number } })
 * const MyEvent = Event({ Start: {}, Loaded: { count: Schema.Number } })
 *
 * class Counter extends Context.Service<
 *   Counter,
 *   { readonly load: () => Effect.Effect<number> }
 * >()("@app/Counter") {}
 *
 * const machine = Machine.make({
 *   state: MyState,
 *   event: MyEvent,
 *   initial: MyState.Idle,
 * })
 *   .on(MyState.Idle, MyEvent.Start, () => MyState.Running)
 *   .task(
 *     MyState.Running,
 *     () => Counter.pipe(Effect.flatMap((counter) => counter.load())),
 *     { onSuccess: (count) => MyEvent.Loaded({ count }) },
 *   )
 *   .on(MyState.Running, MyEvent.Loaded, ({ event }) => MyState.Done({ count: event.count }))
 *   .final(MyState.Done)
 *
 * const CounterLive = Layer.succeed(Counter, { load: () => Effect.succeed(0) })
 * const actor = yield* Machine.spawn(machine).pipe(Effect.provide(CounterLive))
 * ```
 *
 * @module
 */
import type { Duration, Schema } from "effect";
import { Cause, Effect, Exit, Option, Random, Scope } from "effect";

import type { TransitionResult } from "./internal/utils.js";
import { getTag, makeReply, makeDeferReply } from "./internal/utils.js";
import type {
  TaggedOrConstructor,
  BrandedState,
  BrandedEvent,
  ExtractReply,
} from "./internal/brands.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./schema.js";
import type { DuplicateActorError } from "./errors.js";
import { makeEventAdvancement } from "./internal/event-advancement.js";
import { invalidateIndex, executeTransition, shouldPostpone } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import type { ActorRef, ActorSystemService } from "./actor.js";
import { Inspector as InspectorTag } from "./inspection.js";

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
  readonly reply: <Reply>(value: Reply) => Effect.Effect<boolean>;
}

interface ReplySchemaCarrier {
  readonly _replySchemas: ReadonlyMap<string, Schema.Decoder<unknown>>;
}

const hasReplySchemas = <A>(
  schema: Schema.Schema<A>,
): schema is Schema.Schema<A> & ReplySchemaCarrier => "_replySchemas" in schema;

const isStateResolver = <State, Value>(
  value: Value | ((state: State) => Value),
): value is (state: State) => Value => typeof value === "function";

/**
 * Handler context passed to transition handlers
 */
export interface HandlerContext<State, Event> {
  readonly state: State;
  readonly event: Event;
}

/**
 * Handler context passed to state effect handlers (onEnter, spawn, background)
 */
export interface StateHandlerContext<State, Event> {
  readonly actorId: string;
  readonly state: State;
  readonly event: Event;
  readonly self: MachineRef<Event>;
  readonly system: ActorSystemService;
}

/**
 * Transition handler function.
 * When Reply is concrete (event has a reply schema), handler must return Machine.reply().
 * When Reply is never, handler returns plain state.
 */
export type TransitionHandler<S, E, NewState, R, Reply = never> = (
  ctx: HandlerContext<S, E>,
) => TransitionResult<NewState, R, Reply>;

/**
 * State effect handler function
 */
export type StateEffectHandler<S, E, R> = (
  ctx: StateHandlerContext<S, E>,
) => Effect.Effect<void, never, R>;

/**
 * Transition definition
 */
export interface Transition<State, Event, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: TransitionHandler<State, Event, State, R>;
  readonly reenter?: boolean;
}

/**
 * Spawn effect - state-scoped forked effect
 */
export interface SpawnEffect<State, Event, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, R>;
}

/**
 * Background effect - runs for entire machine lifetime
 */
export interface BackgroundEffect<State, Event, R> {
  readonly handler: StateEffectHandler<State, Event, R>;
}

// ============================================================================
// Options types
// ============================================================================

export interface TaskOptions<State, Event, A, E1, ES, EF> {
  readonly onSuccess?: (value: A, ctx: StateHandlerContext<State, Event>) => ES;
  readonly onFailure?: (cause: Cause.Cause<E1>, ctx: StateHandlerContext<State, Event>) => EF;
  readonly name?: string;
}

// ============================================================================
// Recovery / Durability
// ============================================================================

/**
 * Recovery resolves the initial state for a generation. Runs during actor.start.
 *
 * For initial start (generation 0): loads persisted state.
 * For supervision restart (generation 1+): reloads state after crash.
 */
export interface Recovery<S> {
  readonly resolve: (ctx: RecoveryContext<S>) => Effect.Effect<Option.Option<S>>;
}

export interface RecoveryContext<S> {
  readonly actorId: string;
  readonly generation: number;
  readonly machineInitial: S;
}

/**
 * Durability saves state after committed transitions. Runs during runtime.
 */
export interface Durability<S, E> {
  readonly save: (commit: DurabilityCommit<S, E>) => Effect.Effect<void>;
  readonly shouldSave?: (state: S, previousState: S) => boolean;
}

export interface DurabilityCommit<S, E> {
  readonly actorId: string;
  readonly generation: number;
  readonly previousState: S;
  readonly nextState: S;
  readonly event: E;
}

/**
 * Actor lifecycle configuration.
 */
export interface Lifecycle<S, E> {
  readonly recovery?: Recovery<S>;
  readonly durability?: Durability<S, E>;
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

/**
 * `Array.isArray` widens to `any[]` and does not narrow a
 * `T | ReadonlyArray<T>` union, so the normalization below needs an explicit
 * predicate to stay cast-free.
 */
const isReadonlyArray = <T>(value: T | ReadonlyArray<T>): value is ReadonlyArray<T> =>
  Array.isArray(value);

/** Normalize a single value or a readonly array of values into a readonly array. */
const toReadonlyArray = <T>(valueOrValues: T | ReadonlyArray<T>): ReadonlyArray<T> => {
  if (isReadonlyArray<T>(valueOrValues)) {
    return valueOrValues;
  }
  return [valueOrValues];
};

const emitTaskInspection = <S extends { readonly _tag: string }>(input: {
  readonly actorId: string;
  readonly state: S;
  readonly taskName: string | undefined;
  readonly phase: "start" | "success" | "failure" | "interrupt";
  readonly error?: string;
}) =>
  Effect.flatMap(Effect.serviceOption(InspectorTag), (inspector) => {
    if (Option.isNone(inspector)) return Effect.void;
    return emitWithTimestamp(inspector.value, (timestamp) => ({
      type: "@machine.task",
      actorId: input.actorId,
      state: input.state,
      taskName: input.taskName,
      phase: input.phase,
      error: input.error,
      timestamp,
    }));
  });

// ============================================================================
// MakeConfig
// ============================================================================

export interface MakeConfig<
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
> {
  readonly state: MachineStateSchema<SD> & { Type: S };
  readonly event: MachineEventSchema<ED> & { Type: E };
  readonly initial: S;
}

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
 */
export class Machine<
  State,
  Event,
  R = never,
  _SD extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
> {
  readonly initial: State;
  /** @internal */ readonly _transitions: Array<Transition<State, Event, never>>;
  /** @internal */ readonly _spawnEffects: Array<SpawnEffect<State, Event, R>>;
  /** @internal */ readonly _backgroundEffects: Array<BackgroundEffect<State, Event, R>>;
  /** @internal */ readonly _finalStates: Set<string>;
  /** @internal */ readonly _postponeRules: Array<{
    readonly stateTag: string;
    readonly eventTag: string;
  }>;
  readonly stateSchema?: Schema.Schema<State>;
  readonly eventSchema?: Schema.Schema<Event>;
  /** @internal */ readonly _replySchemas: ReadonlyMap<string, Schema.Decoder<unknown>>;

  // Public readonly views
  get transitions(): ReadonlyArray<Transition<State, Event, never>> {
    return this._transitions;
  }
  get spawnEffects(): ReadonlyArray<SpawnEffect<State, Event, R>> {
    return this._spawnEffects;
  }
  get backgroundEffects(): ReadonlyArray<BackgroundEffect<State, Event, R>> {
    return this._backgroundEffects;
  }
  get finalStates(): ReadonlySet<string> {
    return this._finalStates;
  }
  get postponeRules(): ReadonlyArray<{ readonly stateTag: string; readonly eventTag: string }> {
    return this._postponeRules;
  }
  get replySchemas(): ReadonlyMap<string, Schema.Decoder<unknown>> {
    return this._replySchemas;
  }

  /** @internal */
  constructor(
    initial: State,
    stateSchema?: Schema.Schema<State>,
    eventSchema?: Schema.Schema<Event>,
  ) {
    this.initial = initial;
    this._transitions = [];
    this._spawnEffects = [];
    this._backgroundEffects = [];
    this._finalStates = new Set();
    this._postponeRules = [];
    let replySchemas: ReadonlyMap<string, Schema.Decoder<unknown>> = new Map();
    if (eventSchema !== undefined && hasReplySchemas(eventSchema)) {
      replySchemas = eventSchema._replySchemas;
    }
    this._replySchemas = replySchemas;
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;
  }

  // ---- on ----

  from<NS extends VariantsUnion<_SD> & BrandedState, R1>(
    state: TaggedOrConstructor<NS>,
    build: (scope: TransitionScope<State, Event, R, _SD, _ED, NS>) => R1,
  ): Machine<State, Event, R, _SD, _ED>;
  from<NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>, R1>(
    states: NS,
    build: (
      scope: TransitionScope<
        State,
        Event,
        R,
        _SD,
        _ED,
        NS[number] extends TaggedOrConstructor<infer S extends VariantsUnion<_SD> & BrandedState>
          ? S
          : never
      >,
    ) => R1,
  ): Machine<State, Event, R, _SD, _ED>;
  from(
    stateOrStates:
      | TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>
      | ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    build: (
      scope: TransitionScope<State, Event, R, _SD, _ED, VariantsUnion<_SD> & BrandedState>,
    ) => unknown,
  ) {
    const states = toReadonlyArray(stateOrStates);
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
    handler: TransitionHandler<NS, NE, RS, never, ExtractReply<NE>>,
    reenter: boolean,
  ): Machine<State, Event, R, _SD, _ED> {
    for (const state of states) {
      this.addTransition(
        state,
        event,
        handler as unknown as TransitionHandler<NS, NE, BrandedState, never>,
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
    handler: TransitionHandler<NS, NE, RS, never, ExtractReply<NE>>,
  ): Machine<State, Event, R, _SD, _ED>;
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
      never,
      ExtractReply<NE>
    >,
  ): Machine<State, Event, R, _SD, _ED>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(stateOrStates: any, event: any, handler: any): Machine<State, Event, R, _SD, _ED> {
    const states = toReadonlyArray(stateOrStates);
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
    handler: TransitionHandler<NS, NE, RS, never, ExtractReply<NE>>,
  ): Machine<State, Event, R, _SD, _ED>;
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
      never,
      ExtractReply<NE>
    >,
  ): Machine<State, Event, R, _SD, _ED>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  reenter(stateOrStates: any, event: any, handler: any): Machine<State, Event, R, _SD, _ED> {
    let states: any[];
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (Array.isArray(stateOrStates)) {
      states = stateOrStates;
    } else {
      states = [stateOrStates];
    }
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
    handler: TransitionHandler<VariantsUnion<_SD> & BrandedState, NE, RS, never>,
  ): Machine<State, Event, R, _SD, _ED> {
    const eventTag = getTag(event);
    const transition: Transition<State, Event, never> = {
      stateTag: "*",
      eventTag,
      handler: handler as unknown as Transition<State, Event, never>["handler"],
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
    handler: TransitionHandler<NS, NE, BrandedState, never>,
    reenter: boolean,
  ): Machine<State, Event, R, _SD, _ED> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);

    const transition: Transition<State, Event, never> = {
      stateTag,
      eventTag,
      handler: handler as unknown as Transition<State, Event, never>["handler"],
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
   *
   * @example
   * ```ts
   * machine.spawn(State.Loading, ({ self, state }) =>
   *   Effect.gen(function* () {
   *     yield* Effect.addFinalizer(() => Effect.log("Leaving Loading"));
   *     const data = yield* Http.get(state.url);
   *     yield* self.send(Event.Loaded({ data }));
   *   }),
   * );
   * ```
   */
  /** Single state */
  spawn<NS extends VariantsUnion<_SD> & BrandedState, R1>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, VariantsUnion<_ED> & BrandedEvent, Scope.Scope | R1>,
  ): Machine<State, Event, R | R1, _SD, _ED>;
  /** Multiple states */
  spawn<NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>, R1>(
    states: NS,
    handler: StateEffectHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      VariantsUnion<_ED> & BrandedEvent,
      Scope.Scope | R1
    >,
  ): Machine<State, Event, R | R1, _SD, _ED>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawn(stateOrStates: any, handler: any): Machine<State, Event, R, _SD, _ED> {
    const states = toReadonlyArray(stateOrStates);
    for (const s of states) {
      const stateTag = getTag(s);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._spawnEffects as any[]).push({
        stateTag,
        handler: handler as unknown as SpawnEffect<State, Event, R>["handler"],
      });
    }
    invalidateIndex(this);
    return this;
  }

  // ---- task ----

  /**
   * State-scoped task that runs on entry and sends success/failure events.
   * Interrupts do not emit failure events.
   *
   * Supports multi-state and shorthand overloads:
   * - `.task(State.X, run, { onSuccess, onFailure })` — explicit mapping
   * - `.task(State.X, run, { onFailure })` — shorthand when run returns Event directly
   * - `.task([State.X, State.Y], run, opts)` — multi-state
   */
  /** Single state — onSuccess optional (defaults to identity when task returns Event) */
  task<
    NS extends VariantsUnion<_SD> & BrandedState,
    A,
    E1,
    R1,
    ES extends VariantsUnion<_ED> & BrandedEvent,
    EF extends VariantsUnion<_ED> & BrandedEvent,
  >(
    state: TaggedOrConstructor<NS>,
    run: (
      ctx: StateHandlerContext<NS, VariantsUnion<_ED> & BrandedEvent>,
    ) => Effect.Effect<A, E1, Scope.Scope | R1>,
    options: TaskOptions<NS, VariantsUnion<_ED> & BrandedEvent, A, E1, ES, EF>,
  ): Machine<State, Event, R | R1, _SD, _ED>;
  /** Multiple states, explicit onSuccess */
  task<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    A,
    E1,
    R1,
    ES extends VariantsUnion<_ED> & BrandedEvent,
    EF extends VariantsUnion<_ED> & BrandedEvent,
  >(
    states: NS,
    run: (
      ctx: StateHandlerContext<
        NS[number] extends TaggedOrConstructor<infer S> ? S : never,
        VariantsUnion<_ED> & BrandedEvent
      >,
    ) => Effect.Effect<A, E1, Scope.Scope | R1>,
    options: TaskOptions<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      VariantsUnion<_ED> & BrandedEvent,
      A,
      E1,
      ES,
      EF
    >,
  ): Machine<State, Event, R | R1, _SD, _ED>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  task(stateOrStates: any, run: any, options: any): Machine<State, Event, R, _SD, _ED> {
    const handler = Effect.fn("effect-machine.task")(function* (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ctx: StateHandlerContext<any, any>,
    ) {
      yield* emitTaskInspection({
        actorId: ctx.actorId,
        state: ctx.state,
        taskName: options.name,
        phase: "start",
      });

      // @effect-diagnostics anyUnknownInErrorContext:off — implementation overload uses `any`
      const exit = yield* Effect.exit(run(ctx));

      if (Exit.isSuccess(exit)) {
        yield* emitTaskInspection({
          actorId: ctx.actorId,
          state: ctx.state,
          taskName: options.name,
          phase: "success",
        });
        let successEvent = exit.value;
        if (options.onSuccess !== undefined) {
          successEvent = options.onSuccess(exit.value, ctx);
        }
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
      // @effect-diagnostics anyUnknownInErrorContext:off
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
  timeout<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
    config: TimeoutConfig<NS, VariantsUnion<_ED> & BrandedEvent>,
  ): Machine<State, Event, R, _SD, _ED> {
    const stateTag = getTag(state);
    const duration = config.duration;
    const event = config.event;
    const resolveDuration = (currentState: NS): Duration.Input => {
      if (isStateResolver(duration)) return duration(currentState);
      return duration;
    };
    const resolveEvent = (currentState: NS): VariantsUnion<_ED> & BrandedEvent => {
      if (isStateResolver(event)) return event(currentState);
      return event;
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (this as any).task(state, (ctx: any) => Effect.sleep(resolveDuration(ctx.state)), {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onSuccess: (_: void, ctx: any) => resolveEvent(ctx.state),
      name: `$timeout:${stateTag}`,
    });
  }

  // ---- background ----

  /**
   * Machine-lifetime effect that is forked on actor spawn and runs until the actor stops.
   *
   * @example
   * ```ts
   * machine.background(({ self }) =>
   *   Effect.forever(
   *     Effect.sleep("30 seconds").pipe(Effect.andThen(self.send(Event.Ping))),
   *   ),
   * );
   * ```
   */
  background<R1>(
    handler: StateEffectHandler<State, Event, Scope.Scope | R1>,
  ): Machine<State, Event, R | R1, _SD, _ED> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._backgroundEffects as any[]).push({
      handler: handler as unknown as BackgroundEffect<State, Event, R>["handler"],
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
  ): Machine<State, Event, R, _SD, _ED> {
    const stateTag = getTag(state);
    const eventList = toReadonlyArray(events);
    for (const ev of eventList) {
      const eventTag = getTag(ev);
      this._postponeRules.push({ stateTag, eventTag });
    }
    return this;
  }

  // ---- final ----

  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _SD, _ED> {
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
  >(config: MakeConfig<SD, ED, S, E>): Machine<S, E, never, SD, ED> {
    return new Machine<S, E, never, SD, ED>(
      config.initial,
      config.state as unknown as Schema.Schema<S>,
      config.event as unknown as Schema.Schema<E>,
    );
  }
}

class TransitionScope<
  State,
  Event,
  R,
  _SD extends Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields>,
  SelectedState extends VariantsUnion<_SD> & BrandedState,
> {
  constructor(
    private readonly machine: Machine<State, Event, R, _SD, _ED>,
    private readonly states: ReadonlyArray<TaggedOrConstructor<SelectedState>>,
  ) {}

  on<NE extends VariantsUnion<_ED> & BrandedEvent, RS extends VariantsUnion<_SD> & BrandedState>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, never, ExtractReply<NE>>,
  ): TransitionScope<State, Event, R, _SD, _ED, SelectedState> {
    this.machine.scopeTransition(this.states, event, handler, false);
    return this;
  }

  reenter<
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
  >(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, never, ExtractReply<NE>>,
  ): TransitionScope<State, Event, R, _SD, _ED, SelectedState> {
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

import { createActor, ActorScope } from "./actor.js";
import type { Supervision } from "./supervision.js";

/**
 * Spawn an actor directly without ActorSystem ceremony.
 *
 * **Single actor, no registry.** Caller manages lifetime via `actor.stop`.
 * If an `ActorScope` exists in context, cleanup attaches automatically on scope close.
 * Use `Machine.scoped` to bridge from `Scope` to `ActorScope`.
 *
 * For registry, lookup by ID, persistence, or multi-actor coordination,
 * use `ActorSystem` / `system.spawn` instead.
 *
 * @example
 * ```ts
 * // Fire-and-forget — caller manages lifetime
 * const actor = yield* Machine.spawn(machine);
 * yield* actor.start;
 * yield* actor.send(Event.Start);
 * yield* actor.awaitFinal;
 * yield* actor.stop;
 *
 * // Scope-aware — auto-cleans up on scope close
 * yield* Effect.scoped(Machine.scoped(Effect.gen(function* () {
 *   const actor = yield* Machine.spawn(machine);
 *   yield* actor.start;
 *   yield* actor.send(Event.Start);
 *   // actor.stop called automatically when scope closes
 * })));
 * ```
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMachine<S, E, R> = Machine<S, E, R, any, any>;

const spawnImpl = Effect.fn("effect-machine.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
>(
  machine: AnyMachine<S, E, R>,
  idOrOptions?:
    | string
    | {
        id?: string;
        hydrate?: S;
        supervision?: Supervision.Policy;
        lifecycle?: Lifecycle<S, E>;
      },
) {
  let opts: Exclude<typeof idOrOptions, string>;
  if (typeof idOrOptions === "string") {
    opts = { id: idOrOptions };
  } else {
    opts = idOrOptions;
  }
  const actorId = opts?.id ?? `actor-${(yield* Random.next).toString(36).slice(2)}`;
  const actor = yield* createActor(actorId, machine, {
    initialState: opts?.hydrate,
    supervision: opts?.supervision,
    lifecycle: opts?.lifecycle,
  });

  // If an ActorScope exists in context, attach cleanup automatically
  const maybeScope = yield* Effect.serviceOption(ActorScope);
  if (Option.isSome(maybeScope)) {
    yield* Scope.addFinalizer(maybeScope.value, actor.stop);
  }

  return actor;
});

/**
 * Spawn an actor from a machine.
 *
 * @example
 * ```ts
 * const actor = yield* Machine.spawn(machine);
 *
 * // With lifecycle (recovery + durability)
 * const actor = yield* Machine.spawn(machine, {
 *   lifecycle: {
 *     recovery: { resolve: (ctx) => storage.get("actor-state") },
 *     durability: { save: (commit) => storage.set("actor-state", commit.nextState) },
 *   },
 * });
 * ```
 */
export const spawn: <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  machine: Machine<S, E, R, any, any>,
  options?:
    | string
    | {
        id?: string;
        hydrate?: S;
        supervision?: Supervision.Policy;
        lifecycle?: Lifecycle<S, E>;
      },
) => Effect.Effect<ActorRef<S, E>, never, R> = spawnImpl;

/**
 * Wrap an effect to provide an `ActorScope` from the current `Scope`.
 *
 * Actors spawned inside will attach cleanup finalizers to this scope,
 * so they are automatically stopped when the scope closes.
 *
 * @example
 * ```ts
 * yield* Effect.scoped(
 *   Machine.scoped(
 *     Effect.gen(function* () {
 *       const actor = yield* Machine.spawn(machine);
 *       yield* actor.start;
 *       // actor auto-stopped when scope closes
 *     }),
 *   ),
 * );
 * ```
 */
export const scoped = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | Scope.Scope> =>
  Effect.flatMap(Effect.service(Scope.Scope), (scope) =>
    Effect.provideService(effect, ActorScope, scope),
  );

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
>(input: AnyMachine<S, E, R>, events: ReadonlyArray<E>, options?: { from?: S }) {
  const machine = input;
  const advancement = makeEventAdvancement({
    initial: options?.from ?? machine.initial,
    isFinal: (state: S) => machine.finalStates.has(state._tag),
    shouldPostpone: (state: S, event: E) => shouldPostpone(machine, state._tag, event._tag),
    postpone: (_state: S, event: E) => Effect.succeed({ input: event, value: undefined }),
    process: (state: S, event: E) =>
      executeTransition(machine, state, event).pipe(
        Effect.map((result) => ({
          state: result.newState,
          stateChanged:
            result.transitioned && (result.newState._tag !== state._tag || result.reenter),
          shouldStop: result.transitioned && machine.finalStates.has(result.newState._tag),
          value: undefined,
        })),
      ),
  });

  for (const event of events) {
    if (advancement.stopped) break;
    yield* advancement.advance(event);
  }

  return advancement.state;
});

export const replay: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any>,
    events: ReadonlyArray<E>,
    options?: { from?: S },
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
