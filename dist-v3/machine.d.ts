import { TransitionResult } from "./internal/utils.js";
import { BrandedEvent, BrandedState, TaggedOrConstructor } from "./internal/brands.js";
import { MachineEventSchema, MachineStateSchema, VariantsUnion } from "./schema.js";
import { PersistenceConfig, PersistentMachine } from "./persistence/persistent-machine.js";
import { DuplicateActorError } from "./errors.js";
import {
  EffectHandlers,
  EffectSlots,
  EffectsDef,
  EffectsSchema,
  GuardHandlers,
  GuardSlots,
  GuardsDef,
  GuardsSchema,
  MachineContext,
} from "./slot.js";
import { findTransitions } from "./internal/transition.js";
import "./persistence/index.js";
import { ActorRef, ActorSystem } from "./actor.js";
import { Cause, Context, Effect, Schedule, Schema, Scope } from "effect";

//#region src-v3/machine.d.ts
declare namespace machine_d_exports {
  export {
    BackgroundEffect,
    BuiltMachine,
    HandlerContext,
    Machine,
    MachineRef,
    MakeConfig,
    PersistOptions,
    PersistenceConfig,
    PersistentMachine,
    ProvideHandlers,
    SlotContext,
    SpawnEffect,
    StateEffectHandler,
    StateHandlerContext,
    Transition,
    TransitionHandler,
    findTransitions,
    make,
    spawn,
  };
}
/**
 * Self reference for sending events back to the machine
 */
interface MachineRef<Event> {
  readonly send: (event: Event) => Effect.Effect<void>;
  readonly spawn: <
    S2 extends {
      readonly _tag: string;
    },
    E2 extends {
      readonly _tag: string;
    },
    R2,
  >(
    id: string,
    machine: BuiltMachine<S2, E2, R2>,
  ) => Effect.Effect<ActorRef<S2, E2>, DuplicateActorError, R2>;
}
/**
 * Handler context passed to transition handlers
 */
interface HandlerContext<State, Event, GD extends GuardsDef, ED extends EffectsDef> {
  readonly state: State;
  readonly event: Event;
  readonly guards: GuardSlots<GD>;
  readonly effects: EffectSlots<ED>;
}
/**
 * Handler context passed to state effect handlers (onEnter, spawn, background)
 */
interface StateHandlerContext<State, Event, ED extends EffectsDef> {
  readonly state: State;
  readonly event: Event;
  readonly self: MachineRef<Event>;
  readonly effects: EffectSlots<ED>;
  readonly system: ActorSystem;
}
/**
 * Transition handler function
 */
type TransitionHandler<S, E, NewState, GD extends GuardsDef, ED extends EffectsDef, R> = (
  ctx: HandlerContext<S, E, GD, ED>,
) => TransitionResult<NewState, R>;
/**
 * State effect handler function
 */
type StateEffectHandler<S, E, ED extends EffectsDef, R> = (
  ctx: StateHandlerContext<S, E, ED>,
) => Effect.Effect<void, never, R>;
/**
 * Transition definition
 */
interface Transition<State, Event, GD extends GuardsDef, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: TransitionHandler<State, Event, State, GD, ED, R>;
  readonly reenter?: boolean;
}
/**
 * Spawn effect - state-scoped forked effect
 */
interface SpawnEffect<State, Event, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, ED, R>;
}
/**
 * Background effect - runs for entire machine lifetime
 */
interface BackgroundEffect<State, Event, ED extends EffectsDef, R> {
  readonly handler: StateEffectHandler<State, Event, ED, R>;
}
/** Options for `persist` */
interface PersistOptions {
  readonly snapshotSchedule: Schedule.Schedule<
    unknown,
    {
      readonly _tag: string;
    }
  >;
  readonly journalEvents: boolean;
  readonly machineType?: string;
}
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false;
type NormalizeR<T> = IsAny<T> extends true ? T : IsUnknown<T> extends true ? never : T;
interface MakeConfig<
  SD extends Record<string, Schema.Struct.Fields>,
  ED extends Record<string, Schema.Struct.Fields>,
  S extends BrandedState,
  E extends BrandedEvent,
  GD extends GuardsDef,
  EFD extends EffectsDef,
> {
  readonly state: MachineStateSchema<SD> & {
    Type: S;
  };
  readonly event: MachineEventSchema<ED> & {
    Type: E;
  };
  readonly guards?: GuardsSchema<GD>;
  readonly effects?: EffectsSchema<EFD>;
  readonly initial: S;
}
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
type SlotContext<State, Event> = MachineContext<State, Event, MachineRef<Event>>;
/** Combined handlers for build() - guards and effects only */
type ProvideHandlers<
  State,
  Event,
  GD extends GuardsDef,
  EFD extends EffectsDef,
  R,
> = (HasGuardKeys<GD> extends true ? GuardHandlers<GD, SlotContext<State, Event>, R> : object) &
  (HasEffectKeys<EFD> extends true ? EffectHandlers<EFD, SlotContext<State, Event>, R> : object);
/** Whether the machine has any guard or effect slots */
type HasSlots<GD extends GuardsDef, EFD extends EffectsDef> =
  HasGuardKeys<GD> extends true ? true : HasEffectKeys<EFD>;
/**
 * A finalized machine ready for spawning.
 *
 * Created by calling `.build()` on a `Machine`. This is the only type
 * accepted by `Machine.spawn` and `ActorSystem.spawn` (regular overload).
 * Testing utilities (`simulate`, `createTestHarness`, etc.) still accept `Machine`.
 */
declare class BuiltMachine<State, Event, R = never> {
  /** @internal */
  readonly _inner: Machine<State, Event, R, any, any, any, any>;
  /** @internal */
  constructor(machine: Machine<State, Event, R, any, any, any, any>);
  get initial(): State;
  persist(config: PersistOptions): PersistentMachine<
    State & {
      readonly _tag: string;
    },
    Event & {
      readonly _tag: string;
    },
    R
  >;
}
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
declare class Machine<
  State,
  Event,
  R = never,
  _SD extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
> {
  readonly initial: State;
  /** @internal */
  readonly _transitions: Array<Transition<State, Event, GD, EFD, R>>;
  /** @internal */
  readonly _spawnEffects: Array<SpawnEffect<State, Event, EFD, R>>;
  /** @internal */
  readonly _backgroundEffects: Array<BackgroundEffect<State, Event, EFD, R>>;
  /** @internal */
  readonly _finalStates: Set<string>;
  /** @internal */
  readonly _guardsSchema?: GuardsSchema<GD>;
  /** @internal */
  readonly _effectsSchema?: EffectsSchema<EFD>;
  /** @internal */
  readonly _guardHandlers: Map<
    string,
    (params: unknown, ctx: SlotContext<State, Event>) => boolean | Effect.Effect<boolean, never, R>
  >;
  /** @internal */
  readonly _effectHandlers: Map<
    string,
    (params: unknown, ctx: SlotContext<State, Event>) => Effect.Effect<void, never, R>
  >;
  /** @internal */
  readonly _slots: {
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
  >;
  get transitions(): ReadonlyArray<Transition<State, Event, GD, EFD, R>>;
  get spawnEffects(): ReadonlyArray<SpawnEffect<State, Event, EFD, R>>;
  get backgroundEffects(): ReadonlyArray<BackgroundEffect<State, Event, EFD, R>>;
  get finalStates(): ReadonlySet<string>;
  get guardsSchema(): GuardsSchema<GD> | undefined;
  get effectsSchema(): EffectsSchema<EFD> | undefined;
  /** @internal */
  constructor(
    initial: State,
    stateSchema?: Schema.Schema<State, unknown, never>,
    eventSchema?: Schema.Schema<Event, unknown, never>,
    guardsSchema?: GuardsSchema<GD>,
    effectsSchema?: EffectsSchema<EFD>,
  );
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
  /**
   * Register a wildcard transition that fires from any state when no specific transition matches.
   * Specific `.on()` transitions always take priority over `.onAny()`.
   */
  onAny<NE extends VariantsUnion<_ED> & BrandedEvent, RS extends VariantsUnion<_SD> & BrandedState>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<VariantsUnion<_SD> & BrandedState, NE, RS, GD, EFD, never>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  /** @internal */
  private addTransition;
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
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
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
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
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
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD>;
  /**
   * Finalize the machine. Returns a `BuiltMachine` — the only type accepted by `Machine.spawn`.
   *
   * - Machines with slots: pass implementations as the first argument.
   * - Machines without slots: call with no arguments.
   */
  build<R2 = never>(
    ...args: HasSlots<GD, EFD> extends true
      ? [handlers: ProvideHandlers<State, Event, GD, EFD, R2>]
      : [handlers?: ProvideHandlers<State, Event, GD, EFD, R2>]
  ): BuiltMachine<State, Event, R | NormalizeR<R2>>;
  /** @internal Persist from raw Machine — prefer BuiltMachine.persist() */
  persist(config: PersistOptions): PersistentMachine<
    State & {
      readonly _tag: string;
    },
    Event & {
      readonly _tag: string;
    },
    R
  >;
  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
    GD extends GuardsDef = Record<string, never>,
    EFD extends EffectsDef = Record<string, never>,
  >(config: MakeConfig<SD, ED, S, E, GD, EFD>): Machine<S, E, never, SD, ED, GD, EFD>;
}
declare const make: typeof Machine.make;
declare const spawn: {
  <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
  >(
    machine: BuiltMachine<S, E, R>,
  ): Effect.Effect<ActorRef<S, E>, never, R>;
  <
    S extends {
      readonly _tag: string;
    },
    E extends {
      readonly _tag: string;
    },
    R,
  >(
    machine: BuiltMachine<S, E, R>,
    id: string,
  ): Effect.Effect<ActorRef<S, E>, never, R>;
};
//#endregion
export {
  BackgroundEffect,
  BuiltMachine,
  HandlerContext,
  Machine,
  MachineRef,
  MakeConfig,
  PersistOptions,
  type PersistenceConfig,
  type PersistentMachine,
  ProvideHandlers,
  SlotContext,
  SpawnEffect,
  StateEffectHandler,
  StateHandlerContext,
  Transition,
  TransitionHandler,
  findTransitions,
  machine_d_exports,
  make,
  spawn,
};
