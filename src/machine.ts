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
import { getTag, INTERNAL_INIT_EVENT, makeReply, makeDeferReply } from "./internal/utils.js";
import type {
  TaggedOrConstructor,
  BrandedState,
  BrandedEvent,
  ExtractReply,
} from "./internal/brands.js";
import { getReplySchemas } from "./schema.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./schema.js";
import type { DuplicateActorError } from "./errors.js";
import { makeEventAdvancement } from "./internal/event-advancement.js";
import { executeTransition, shouldPostpone } from "./internal/transition.js";
import { emitWithTimestamp } from "./internal/inspection.js";
import type { BackgroundEffect, SpawnEffect, Transition } from "./internal/machine-definition.js";
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

/** A named pure condition for a transition candidate. */
export interface Guard<State, Event, Params = unknown> {
  readonly name: string;
  readonly check: (ctx: HandlerContext<State, Event>) => boolean;
  readonly params?: (ctx: HandlerContext<State, Event>) => Params;
}

/** Optional behavior for one transition candidate. */
export interface TransitionOptions<State, Event> {
  readonly guard?: Guard<State, Event, unknown>;
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

export interface InputMakeConfig<
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
  Input,
> {
  readonly state: MachineStateSchema<SD> & { Type: S };
  readonly event: MachineEventSchema<ED> & { Type: E };
  readonly initial: (input: Input) => S;
}

export interface FinalContext<State> {
  readonly state: State;
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
  Input = void,
  Output = State,
> {
  readonly initial: Input extends void ? State : never;
  readonly #initialize: (input: Input) => State;
  readonly #backgroundEffects: Array<BackgroundEffect<State, Event, R>>;
  readonly #finalStates: Set<string>;
  readonly #finalOutputs: Map<string, (state: State) => unknown>;
  readonly #postponeRules: Array<{
    readonly stateTag: string;
    readonly eventTag: string;
  }>;
  readonly stateSchema: MachineStateSchema<_SD> & { readonly Type: State };
  readonly eventSchema: MachineEventSchema<_ED> & { readonly Type: Event };
  readonly #replySchemas: ReadonlyMap<string, Schema.Decoder<unknown>>;
  readonly #transitionIndex: Map<string, Map<string, Array<Transition<State, Event, never>>>>;
  readonly #immediateIndex: Map<string, Array<Transition<State, Event, never>>>;
  readonly #spawnIndex: Map<string, Array<SpawnEffect<State, Event, R>>>;

  /** @internal */
  constructor(
    initial: State | ((input: Input) => State),
    stateSchema: MachineStateSchema<_SD> & { readonly Type: State },
    eventSchema: MachineEventSchema<_ED> & { readonly Type: Event },
  ) {
    if (typeof initial === "function") {
      this.#initialize = initial as (input: Input) => State;
      this.initial = undefined as Input extends void ? State : never;
    } else {
      this.#initialize = () => initial;
      this.initial = initial as Input extends void ? State : never;
    }
    this.#backgroundEffects = [];
    this.#finalStates = new Set();
    this.#finalOutputs = new Map();
    this.#postponeRules = [];
    this.#transitionIndex = new Map();
    this.#immediateIndex = new Map();
    this.#spawnIndex = new Map();
    this.#replySchemas = getReplySchemas(eventSchema) ?? new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;
  }

  // ---- on ----

  from<NS extends VariantsUnion<_SD> & BrandedState, R1>(
    state: TaggedOrConstructor<NS>,
    build: (
      scope: TransitionScope<State, Event, R, _SD, _ED, NS, Input, Output>,
    ) => TransitionScope<State, Event, R, _SD, _ED, NS, Input, Output, R1>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
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
          : never,
        Input,
        Output
      >,
    ) => TransitionScope<
      State,
      Event,
      R,
      _SD,
      _ED,
      NS[number] extends TaggedOrConstructor<infer S extends VariantsUnion<_SD> & BrandedState>
        ? S
        : never,
      Input,
      Output,
      R1
    >,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  from(
    stateOrStates:
      | TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>
      | ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    build: (
      scope: TransitionScope<
        State,
        Event,
        R,
        _SD,
        _ED,
        VariantsUnion<_SD> & BrandedState,
        Input,
        Output
      >,
    ) => TransitionScope<
      State,
      Event,
      R,
      _SD,
      _ED,
      VariantsUnion<_SD> & BrandedState,
      Input,
      Output,
      unknown
    >,
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
    R1,
  >(
    states: ReadonlyArray<TaggedOrConstructor<NS>>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, R1, ExtractReply<NE>>,
    reenter: boolean,
    options?: TransitionOptions<NS, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output> {
    for (const state of states) {
      this.addTransition(
        state,
        event,
        handler as unknown as TransitionHandler<NS, NE, BrandedState, never>,
        reenter,
        options,
      );
    }
    return this;
  }

  /** Register transition for a single state */
  on<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, R1, ExtractReply<NE>>,
    options?: TransitionOptions<NS, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /** Register transition for multiple states (handler receives union of state types) */
  on<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    states: NS,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      NE,
      RS,
      R1,
      ExtractReply<NE>
    >,
    options?: TransitionOptions<NS[number] extends TaggedOrConstructor<infer S> ? S : never, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /* eslint-disable @typescript-eslint/no-explicit-any -- overload implementation */
  on(
    stateOrStates: any,
    event: any,
    handler: any,
    options?: any,
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const states = toReadonlyArray(stateOrStates);
    for (const s of states) {
      this.addTransition(s, event, handler, false, options);
    }
    return this;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

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
    R1 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, R1, ExtractReply<NE>>,
    options?: TransitionOptions<NS, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /** Multiple states */
  reenter<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    states: NS,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      NE,
      RS,
      R1,
      ExtractReply<NE>
    >,
    options?: TransitionOptions<NS[number] extends TaggedOrConstructor<infer S> ? S : never, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  reenter(
    stateOrStates: any,
    event: any,
    handler: any,
    options?: any,
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
    let states: any[];
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (Array.isArray(stateOrStates)) {
      states = stateOrStates;
    } else {
      states = [stateOrStates];
    }
    for (const s of states) {
      this.addTransition(s, event, handler, true, options);
    }
    return this;
  }

  // ---- onAny ----

  /**
   * Register a wildcard transition that fires from any state when no specific transition matches.
   * Specific `.on()` transitions always take priority over `.onAny()`.
   */
  onAny<
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<VariantsUnion<_SD> & BrandedState, NE, RS, R1>,
    options?: TransitionOptions<VariantsUnion<_SD> & BrandedState, NE>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output> {
    const eventTag = getTag(event);
    const transition: Transition<State, Event, never> = {
      stateTag: "*",
      eventTag,
      handler: handler as unknown as Transition<State, Event, never>["handler"],
      reenter: false,
      guard: options?.guard as Guard<State, Event, unknown> | undefined,
    };
    this.registerTransition(transition);
    return this;
  }

  /** @internal */
  private addTransition<NS extends BrandedState, NE extends BrandedEvent>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, BrandedState, unknown>,
    reenter: boolean,
    options?: TransitionOptions<NS, NE>,
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);

    const transition: Transition<State, Event, never> = {
      stateTag,
      eventTag,
      handler: handler as unknown as Transition<State, Event, never>["handler"],
      reenter,
      guard: options?.guard as Guard<State, Event, unknown> | undefined,
    };

    this.registerTransition(transition);

    return this;
  }

  // ---- immediate ----

  /**
   * Register an eventless transition. The actor runs immediate transitions until stable.
   * UI observers see only the stable state.
   */
  immediate<
    NS extends VariantsUnion<_SD> & BrandedState,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    state: TaggedOrConstructor<NS>,
    handler: TransitionHandler<NS, VariantsUnion<_ED> & BrandedEvent, RS, R1>,
    options?: TransitionOptions<NS, VariantsUnion<_ED> & BrandedEvent>,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  immediate<
    NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    states: NS,
    handler: TransitionHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      VariantsUnion<_ED> & BrandedEvent,
      RS,
      R1
    >,
    options?: TransitionOptions<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      VariantsUnion<_ED> & BrandedEvent
    >,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /* eslint-disable @typescript-eslint/no-explicit-any -- overload implementation */
  immediate(
    stateOrStates: any,
    handler: any,
    options?: any,
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const states = toReadonlyArray(stateOrStates);
    for (const state of states) {
      const stateTag = getTag(state);
      const transitions = this.#immediateIndex.get(stateTag) ?? [];
      transitions.push({
        stateTag,
        eventTag: "",
        handler,
        guard: options?.guard,
      });
      this.#immediateIndex.set(stateTag, transitions);
    }
    return this;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

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
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /** Multiple states */
  spawn<NS extends ReadonlyArray<TaggedOrConstructor<VariantsUnion<_SD> & BrandedState>>, R1>(
    states: NS,
    handler: StateEffectHandler<
      NS[number] extends TaggedOrConstructor<infer S> ? S : never,
      VariantsUnion<_ED> & BrandedEvent,
      Scope.Scope | R1
    >,
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spawn(stateOrStates: any, handler: any): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const states = toReadonlyArray(stateOrStates);
    for (const s of states) {
      const stateTag = getTag(s);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const spawnEffect: SpawnEffect<State, Event, R> = {
        stateTag,
        handler: handler as unknown as SpawnEffect<State, Event, R>["handler"],
      };
      const effects = this.#spawnIndex.get(stateTag) ?? [];
      effects.push(spawnEffect);
      this.#spawnIndex.set(stateTag, effects);
    }
    return this;
  }

  /** @internal */
  _findTransitions(
    stateTag: string,
    eventTag: string,
  ): ReadonlyArray<Transition<State, Event, never>> {
    const specific = this.#transitionIndex.get(stateTag)?.get(eventTag) ?? [];
    const wildcard = this.#transitionIndex.get("*")?.get(eventTag) ?? [];
    if (specific.length === 0) return wildcard;
    if (wildcard.length === 0) return specific;
    return [...specific, ...wildcard];
  }

  /** @internal */
  _findSpawnEffects(stateTag: string): ReadonlyArray<SpawnEffect<State, Event, R>> {
    return this.#spawnIndex.get(stateTag) ?? [];
  }

  /** @internal */
  _findImmediateTransitions(stateTag: string): ReadonlyArray<Transition<State, Event, never>> {
    return this.#immediateIndex.get(stateTag) ?? [];
  }

  /** @internal */
  _backgroundEffectEntries(): Iterable<BackgroundEffect<State, Event, R>> {
    return this.#backgroundEffects.values();
  }

  /** @internal */
  _isFinal(stateTag: string): boolean {
    return this.#finalStates.has(stateTag);
  }

  /** @internal */
  _initial(input: Input): State {
    return this.#initialize(input);
  }

  /** @internal */
  _output(state: State): Output {
    const resolve = this.#finalOutputs.get((state as { readonly _tag: string })._tag);
    if (resolve === undefined) return state as unknown as Output;
    return resolve(state) as Output;
  }

  /** @internal */
  _shouldPostpone(stateTag: string, eventTag: string): boolean {
    return this.#postponeRules.some(
      (rule) => rule.stateTag === stateTag && rule.eventTag === eventTag,
    );
  }

  /** @internal */
  _hasPostponeRules(): boolean {
    return this.#postponeRules.length > 0;
  }

  /** @internal */
  _replySchema(eventTag: string): Schema.Decoder<unknown> | undefined {
    return this.#replySchemas.get(eventTag);
  }

  /** @internal */
  _withInitial(initial: State): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const copy = new Machine<State, Event, R, _SD, _ED, Input, Output>(
      initial,
      this.stateSchema,
      this.eventSchema,
    );
    copy.#backgroundEffects.push(...this.#backgroundEffects);
    for (const stateTag of this.#finalStates) copy.#finalStates.add(stateTag);
    for (const [stateTag, resolve] of this.#finalOutputs) {
      copy.#finalOutputs.set(stateTag, resolve);
    }
    copy.#postponeRules.push(...this.#postponeRules);
    for (const [stateTag, events] of this.#transitionIndex) {
      const eventCopy = new Map<string, Array<Transition<State, Event, never>>>();
      for (const [eventTag, transitions] of events) {
        eventCopy.set(eventTag, transitions.slice());
      }
      copy.#transitionIndex.set(stateTag, eventCopy);
    }
    for (const [stateTag, transitions] of this.#immediateIndex) {
      copy.#immediateIndex.set(stateTag, transitions.slice());
    }
    for (const [stateTag, effects] of this.#spawnIndex) {
      copy.#spawnIndex.set(stateTag, effects.slice());
    }
    return copy;
  }

  private registerTransition(transition: Transition<State, Event, never>): void {
    const events = this.#transitionIndex.get(transition.stateTag) ?? new Map();
    const transitions = events.get(transition.eventTag) ?? [];
    transitions.push(transition);
    events.set(transition.eventTag, transitions);
    this.#transitionIndex.set(transition.stateTag, events);
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
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
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
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output>;
  /* eslint-disable @typescript-eslint/no-explicit-any -- overload implementation */
  task(
    stateOrStates: any,
    run: any,
    options: any,
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
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
  /* eslint-enable @typescript-eslint/no-explicit-any */

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
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
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
  ): Machine<State, Event, R | R1, _SD, _ED, Input, Output> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.#backgroundEffects as any[]).push({
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
  ): Machine<State, Event, R, _SD, _ED, Input, Output> {
    const stateTag = getTag(state);
    const eventList = toReadonlyArray(events);
    for (const ev of eventList) {
      const eventTag = getTag(ev);
      this.#postponeRules.push({ stateTag, eventTag });
    }
    return this;
  }

  // ---- final ----

  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _SD, _ED, Input, Output | NS>;
  final<NS extends VariantsUnion<_SD> & BrandedState, O>(
    state: TaggedOrConstructor<NS>,
    output: (ctx: FinalContext<NS>) => O,
  ): Machine<State, Event, R, _SD, _ED, Input, Output | O>;
  final<NS extends VariantsUnion<_SD> & BrandedState, O>(
    state: TaggedOrConstructor<NS>,
    output?: (ctx: FinalContext<NS>) => O,
  ): Machine<State, Event, R, _SD, _ED, Input, Output | NS | O> {
    const stateTag = getTag(state);
    this.#finalStates.add(stateTag);
    if (output === undefined) {
      this.#finalOutputs.set(stateTag, (finalState) => finalState);
    } else {
      this.#finalOutputs.set(stateTag, (finalState) =>
        output({ state: finalState as unknown as NS }),
      );
    }
    return this as Machine<State, Event, R, _SD, _ED, Input, Output | NS | O>;
  }

  // ---- build ----

  // ---- Static factory ----

  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
  >(config: MakeConfig<SD, ED, S, E>): Machine<S, E, never, SD, ED, void, never>;
  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
    Input,
  >(config: InputMakeConfig<SD, ED, S, E, Input>): Machine<S, E, never, SD, ED, Input, never>;
  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
    Input,
  >(
    config: MakeConfig<SD, ED, S, E> | InputMakeConfig<SD, ED, S, E, Input>,
  ): Machine<S, E, never, SD, ED, Input, never> {
    return new Machine<S, E, never, SD, ED, Input, never>(
      config.initial,
      config.state,
      config.event,
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
  Input,
  Output,
  RAdded = never,
> {
  constructor(
    private readonly machine: Machine<State, Event, R, _SD, _ED, Input, Output>,
    private readonly states: ReadonlyArray<TaggedOrConstructor<SelectedState>>,
  ) {}

  on<
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, R1, ExtractReply<NE>>,
    options?: TransitionOptions<SelectedState, NE>,
  ): TransitionScope<State, Event, R, _SD, _ED, SelectedState, Input, Output, RAdded | R1> {
    this.machine.scopeTransition(this.states, event, handler, false, options);
    return this as TransitionScope<
      State,
      Event,
      R,
      _SD,
      _ED,
      SelectedState,
      Input,
      Output,
      RAdded | R1
    >;
  }

  reenter<
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R1 = never,
  >(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<SelectedState, NE, RS, R1, ExtractReply<NE>>,
    options?: TransitionOptions<SelectedState, NE>,
  ): TransitionScope<State, Event, R, _SD, _ED, SelectedState, Input, Output, RAdded | R1> {
    this.machine.scopeTransition(this.states, event, handler, true, options);
    return this as TransitionScope<
      State,
      Event,
      R,
      _SD,
      _ED,
      SelectedState,
      Input,
      Output,
      RAdded | R1
    >;
  }
}

// ============================================================================
// make function (alias for Machine.make)
// ============================================================================

export const make = Machine.make;

/** Create a reusable named transition guard. */
export const guard = <State, Event, Params = never>(
  name: string,
  check: (ctx: HandlerContext<State, Event>) => boolean,
  params?: (ctx: HandlerContext<State, Event>) => Params,
): Guard<State, Event, Params> => ({ name, check, params });

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
type AnyMachine<S, E, R, Input = void, Output = S> = Machine<S, E, R, any, any, Input, Output>;

export type SpawnOptions<S, E, Input> = {
  readonly id?: string;
  readonly hydrate?: S;
  readonly supervision?: Supervision.Policy;
  readonly lifecycle?: Lifecycle<S, E>;
} & ([Input] extends [void] ? { readonly input?: never } : { readonly input: Input });

const spawnImpl = Effect.fn("effect-machine.spawn")(function* <
  S extends { readonly _tag: string },
  E extends { readonly _tag: string },
  R,
  Input,
  Output,
>(machine: AnyMachine<S, E, R, Input, Output>, idOrOptions?: string | SpawnOptions<S, E, Input>) {
  let opts: SpawnOptions<S, E, Input> | undefined;
  if (typeof idOrOptions === "string") {
    opts = { id: idOrOptions } as SpawnOptions<S, E, Input>;
  } else {
    opts = idOrOptions;
  }
  const actorId = opts?.id ?? `actor-${(yield* Random.next).toString(36).slice(2)}`;
  const machineInitial = machine._initial(opts?.input as Input);
  const initialState = opts?.hydrate ?? machineInitial;
  const actor = yield* createActor(actorId, machine, {
    initialState,
    machineInitial,
    hydrated: opts?.hydrate !== undefined,
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
export const spawn: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, Output>(
    machine: AnyMachine<S, E, R, void, Output>,
    options?: string | SpawnOptions<S, E, void>,
  ): Effect.Effect<ActorRef<S, E, Output>, never, R>;
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, Input, Output>(
    machine: AnyMachine<S, E, R, Input, Output>,
    options: SpawnOptions<S, E, Input>,
  ): Effect.Effect<ActorRef<S, E, Output>, never, R>;
} = spawnImpl;

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
  Input,
>(
  input: AnyMachine<S, E, R, Input, unknown>,
  events: ReadonlyArray<E>,
  options?: ReplayOptions<S, Input>,
) {
  const machine = input;
  const from = options?.from ?? machine._initial(options?.input as Input);
  const initial = yield* executeTransition(machine, from, { _tag: INTERNAL_INIT_EVENT } as E);
  const advancement = makeEventAdvancement({
    initial: initial.newState,
    isFinal: (state: S) => machine._isFinal(state._tag),
    shouldPostpone: (state: S, event: E) => shouldPostpone(machine, state._tag, event._tag),
    postpone: (_state: S, event: E) => Effect.succeed({ input: event, value: undefined }),
    process: (state: S, event: E) =>
      executeTransition(machine, state, event).pipe(
        Effect.map((result) => ({
          state: result.newState,
          transitioned: result.transitioned,
          stateChanged:
            result.transitioned && (result.newState._tag !== state._tag || result.reenter),
          shouldStop: result.transitioned && machine._isFinal(result.newState._tag),
          value: undefined,
        })),
      ),
  });

  for (const event of events) {
    yield* advancement.advance(event);
  }

  return advancement.state;
});

export type ReplayOptions<S, Input> =
  | { readonly from: S; readonly input?: never }
  | ([Input] extends [void]
      ? { readonly from?: never; readonly input?: never }
      : { readonly from?: never; readonly input: Input });

export const replay: {
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, void, any>,
    events: ReadonlyArray<E>,
    options?: ReplayOptions<S, void>,
  ): Effect.Effect<S, never, R>;
  <S extends { readonly _tag: string }, E extends { readonly _tag: string }, R, Input>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    machine: Machine<S, E, R, any, any, Input, any>,
    events: ReadonlyArray<E>,
    options: ReplayOptions<S, Input>,
  ): Effect.Effect<S, never, R>;
} = replayImpl;

// Reply helpers
export const reply = makeReply;
export const deferReply = makeDeferReply;
export type { DeferReplyResult, ReplyResult } from "./internal/utils.js";

// Supervision (Machine.supervise) deferred to a dedicated PR — requires
// deeper integration with the runtime kernel for defect detection and
// restart semantics that don't fit cleanly into the current ActorRef surface.
