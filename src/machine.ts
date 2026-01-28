import type { Schema, Schedule } from "effect";
import { Context, Duration, Effect } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";

import type { TransitionResult } from "./internal/types.js";
import type { TaggedOrConstructor, BrandedState, BrandedEvent } from "./internal/brands.js";
import { getTag } from "./internal/get-tag.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./machine-schema.js";
import type { PersistentMachine, WithPersistenceConfig } from "./persistence/persistent-machine.js";
import { persist as persistImpl } from "./persistence/persistent-machine.js";
import { MissingSlotHandlerError, UnknownSlotError } from "./errors.js";
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

/** Duration input for delay */
export type DurationOrFn<S> = Duration.DurationInput | ((state: S) => Duration.DurationInput);

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
  readonly stateSchema?: Schema.Schema<State, unknown, never>;
  readonly eventSchema?: Schema.Schema<Event, unknown, never>;

  /**
   * Context tag for accessing machine state/event/self in slot handlers.
   * Each machine instance gets its own typed Context.Tag.
   */
  readonly Context: Context.Tag<
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
    this.Context = Context.GenericTag<MachineContext<State, Event, MachineRef<Event>>>(
      `effect-machine/Context/${Math.random().toString(36).slice(2)}`,
    );
  }

  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments);
  }

  // ---- on ----

  on<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _SD, _ED, GD, EFD> {
    return this.addTransition(state, event, handler, false);
  }

  // ---- reenter ----

  /**
   * Like `on()`, but forces onEnter/spawn to run even when transitioning to the same state tag.
   * Use this to restart timers, re-run spawned effects, or reset state-scoped effects.
   */
  reenter<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _SD, _ED, GD, EFD> {
    return this.addTransition(state, event, handler, true);
  }

  /** @internal */
  private addTransition<NS extends BrandedState, NE extends BrandedEvent, R2>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, BrandedState, GD, EFD, R2>,
    reenter: boolean,
  ): Machine<State, Event, R | R2, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);

    const transition: Transition<State, Event, GD, EFD, R | R2> = {
      stateTag,
      eventTag,
      handler: handler as unknown as Transition<State, Event, GD, EFD, R | R2>["handler"],
      reenter: reenter || undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._transitions as any[]).push(transition);

    return this as unknown as Machine<State, Event, R | R2, _SD, _ED, GD, EFD>;
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
  spawn<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, VariantsUnion<_ED> & BrandedEvent, EFD, R2>,
  ): Machine<State, Event, R | R2, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._spawnEffects as any[]).push({
      stateTag,
      handler: handler as unknown as SpawnEffect<State, Event, EFD, R | R2>["handler"],
    });
    return this as unknown as Machine<State, Event, R | R2, _SD, _ED, GD, EFD>;
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
  background<R2 = never>(
    handler: StateEffectHandler<State, Event, EFD, R2>,
  ): Machine<State, Event, R | R2, _SD, _ED, GD, EFD> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._backgroundEffects as any[]).push({
      handler: handler as unknown as BackgroundEffect<State, Event, EFD, R | R2>["handler"],
    });
    return this as unknown as Machine<State, Event, R | R2, _SD, _ED, GD, EFD>;
  }

  // ---- delay ----

  /**
   * Schedule an event to be sent after a delay when entering a state.
   * The timer is automatically cancelled when exiting the state.
   */
  delay<NS extends VariantsUnion<_SD> & BrandedState, NE extends VariantsUnion<_ED> & BrandedEvent>(
    state: TaggedOrConstructor<NS>,
    duration: DurationOrFn<NS>,
    event: TaggedOrConstructor<NE>,
  ): Machine<State, Event, R, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);

    // Get event value (if constructor, call it)
    const eventValue = typeof event === "function" ? (event as () => BrandedEvent)() : event;

    // Pre-decode if static duration
    const staticDuration = typeof duration !== "function" ? Duration.decode(duration) : null;

    // Use spawn for delay - the effect is automatically cancelled on state exit
    const delayHandler = (ctx: StateHandlerContext<State, Event, EFD>) => {
      const dur =
        staticDuration ??
        Duration.decode(
          (duration as (s: NS) => Duration.DurationInput)(ctx.state as unknown as NS),
        );
      return Effect.sleep(dur).pipe(Effect.andThen(ctx.self.send(eventValue as Event)));
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._spawnEffects as any[]).push({ stateTag, handler: delayHandler });
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
    // Collect all required slot names
    const requiredSlots = new Set<string>();

    // Guards from schema
    if (this._guardsSchema !== undefined) {
      for (const name of Object.keys(this._guardsSchema.definitions)) {
        requiredSlots.add(name);
      }
    }

    // Effects from schema
    if (this._effectsSchema !== undefined) {
      for (const name of Object.keys(this._effectsSchema.definitions)) {
        requiredSlots.add(name);
      }
    }

    // Validate all slots have handlers
    for (const name of requiredSlots) {
      if (!(name in handlers)) {
        throw new MissingSlotHandlerError({ slotName: name });
      }
    }

    // Validate no extra handlers
    for (const name of Object.keys(handlers)) {
      if (!requiredSlots.has(name)) {
        throw new UnknownSlotError({ slotName: name });
      }
    }

    // Create new machine to preserve original for reuse with different providers
    const result = new Machine<State, Event, R | R2, _SD, _ED, GD, EFD>(
      this.initial,
      this.stateSchema as Schema.Schema<State, unknown, never>,
      this.eventSchema as Schema.Schema<Event, unknown, never>,
      this._guardsSchema,
      this._effectsSchema,
    );

    // Copy context tag
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any).Context = this.Context;

    // Share immutable arrays (never mutated after provide)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._transitions = this._transitions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._finalStates = this._finalStates;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._spawnEffects = this._spawnEffects;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._backgroundEffects = this._backgroundEffects;

    // Copy existing handlers
    for (const [k, v] of this._guardHandlers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result._guardHandlers as Map<string, any>).set(k, v);
    }
    for (const [k, v] of this._effectHandlers) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result._effectHandlers as Map<string, any>).set(k, v);
    }

    // Register guard handlers - handlers receive (params, ctx)
    if (this._guardsSchema !== undefined) {
      for (const name of Object.keys(this._guardsSchema.definitions)) {
        const handler = (handlers as Record<string, unknown>)[name] as (
          params: unknown,
          ctx: SlotContext<State, Event>,
        ) => boolean | Effect.Effect<boolean, never, R2>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result._guardHandlers as Map<string, any>).set(name, handler);
      }
    }

    // Register effect handlers - handlers receive (params, ctx)
    if (this._effectsSchema !== undefined) {
      for (const name of Object.keys(this._effectsSchema.definitions)) {
        const handler = (handlers as Record<string, unknown>)[name] as (
          params: unknown,
          ctx: SlotContext<State, Event>,
        ) => Effect.Effect<void, never, R2>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result._effectHandlers as Map<string, any>).set(name, handler);
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
   * Create guard and effect slot accessors for use in handlers.
   * @internal Used by the event loop to create typed accessors.
   */
  _createSlotAccessors(ctx: MachineContext<State, Event, MachineRef<Event>>): {
    guards: GuardSlots<GD>;
    effects: EffectSlots<EFD>;
  } {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;

    // Create guard slots that resolve to actual handlers
    const guards =
      this._guardsSchema !== undefined
        ? this._guardsSchema._createSlots((name: string, params: unknown) => {
            const handler = machine._guardHandlers.get(name);
            if (handler === undefined) {
              return Effect.die(new Error(`Guard handler not found: ${name}`));
            }
            const result = handler(params, ctx);
            // Handler may return boolean or Effect<boolean>
            const normalized = typeof result === "boolean" ? Effect.succeed(result) : result;
            return normalized.pipe(Effect.provideService(machine.Context, ctx)) as Effect.Effect<
              boolean,
              never,
              never
            >;
          })
        : ({} as GuardSlots<GD>);

    // Create effect slots that resolve to actual handlers
    const effects =
      this._effectsSchema !== undefined
        ? this._effectsSchema._createSlots((name: string, params: unknown) => {
            const handler = machine._effectHandlers.get(name);
            if (handler === undefined) {
              return Effect.die(new Error(`Effect handler not found: ${name}`));
            }
            return handler(params, ctx).pipe(
              Effect.provideService(machine.Context, ctx),
            ) as Effect.Effect<void, never, never>;
          })
        : ({} as EffectSlots<EFD>);

    return { guards, effects };
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
