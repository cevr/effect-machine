import type { Schema, Schedule } from "effect";
import { Context, Duration, Effect, Fiber } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import { createFiberStorage } from "./internal/fiber-storage.js";

import type { StateEffectContext, TransitionResult } from "./internal/types.js";
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
 * Handler context passed to state effect handlers (onEnter, onExit)
 */
export interface StateHandlerContext<State, Event, ED extends EffectsDef> {
  readonly state: State;
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
 * Always (eventless) transition definition
 */
export interface AlwaysTransition<State, GD extends GuardsDef, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly handler: (
    state: State,
    guards: GuardSlots<GD>,
    effects: EffectSlots<ED>,
  ) => TransitionResult<State, R>;
}

/**
 * Entry/exit effect definition
 */
export interface StateEffect<State, Event, ED extends EffectsDef, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, ED, R>;
}

/**
 * Root invoke effect - runs for entire machine lifetime
 */
export interface RootInvoke<State, Event, R> {
  readonly name: string;
  readonly handler: (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R>;
}

/**
 * Effect slot - named slot for effect provision (legacy, for invoke only)
 */
export type EffectSlot =
  | { readonly type: "invoke"; readonly stateTag: string | null; readonly name: string }
  | { readonly type: "onEnter"; readonly stateTag: string; readonly name: string }
  | { readonly type: "onExit"; readonly stateTag: string; readonly name: string };

/**
 * Type-level effect slot for phantom type tracking
 */
export type EffectSlotType<Type extends "invoke" | "onEnter" | "onExit", Name extends string> = {
  readonly type: Type;
  readonly name: Name;
};

/** Any effect slot type (for constraints) */
export type AnySlot = EffectSlotType<"invoke" | "onEnter" | "onExit", string>;

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

type InvokeSlots<Names extends readonly string[]> = Names[number] extends infer Name
  ? Name extends string
    ? EffectSlotType<"invoke", Name>
    : never
  : never;

// ============================================================================
// FromScope - scoped builder for from()
// ============================================================================

/**
 * Scoped builder for `from()` - allows event-only `on()` calls
 */
export interface FromScope<
  NarrowedState extends BrandedState,
  EventUnion extends BrandedEvent,
  StateUnion extends BrandedState,
  GD extends GuardsDef,
  ED extends EffectsDef,
  R = never,
> {
  on<NE extends EventUnion, RS extends StateUnion, R2 = never>(
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NarrowedState, NE, RS, GD, ED, R2>,
  ): FromScope<NarrowedState, EventUnion, StateUnion, GD, ED, R | R2>;
}

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
// OnMethod type - callable with .force submethod
// ============================================================================

/** The `on` method interface with `force` submethod */
export interface OnMethod<
  State,
  Event,
  R,
  _Slots extends AnySlot,
  _SD extends Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef,
  EFD extends EffectsDef,
> {
  <
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;

  force: OnForceMethod<State, Event, R, _Slots, _SD, _ED, GD, EFD>;
}

/** The `on.force` method interface */
export interface OnForceMethod<
  State,
  Event,
  R,
  _Slots extends AnySlot,
  _SD extends Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef,
  EFD extends EffectsDef,
> {
  <
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
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

/** Combined handlers for provide() */
export type ProvideHandlers<
  State,
  Event,
  GD extends GuardsDef,
  EFD extends EffectsDef,
  _Slots extends AnySlot,
  R,
> = (HasGuardKeys<GD> extends true ? GuardHandlers<GD, SlotContext<State, Event>, R> : object) &
  (HasEffectKeys<EFD> extends true
    ? SlotEffectHandlers<EFD, SlotContext<State, Event>, R>
    : object) &
  ([_Slots] extends [never]
    ? object
    : {
        [K in _Slots["name"]]: (
          ctx: StateEffectContext<State, Event>,
        ) => Effect.Effect<void, never, R>;
      });

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
 * - `_Slots`: Phantom type tracking unprovided effect slots
 * - `_SD`: State schema definition (for compile-time validation)
 * - `_ED`: Event schema definition (for compile-time validation)
 * - `GD`: Guard definitions
 * - `EFD`: Effect definitions
 */
export class Machine<
  State,
  Event,
  R = never,
  _Slots extends AnySlot = never,
  _SD extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
> implements Pipeable {
  readonly initial: State;
  /** @internal */ readonly _transitions: Array<Transition<State, Event, GD, EFD, R>>;
  /** @internal */ readonly _alwaysTransitions: Array<AlwaysTransition<State, GD, EFD, R>>;
  /** @internal */ readonly _onEnterEffects: Array<StateEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _onExitEffects: Array<StateEffect<State, Event, EFD, R>>;
  /** @internal */ readonly _rootInvokes: Array<RootInvoke<State, Event, R>>;
  /** @internal */ readonly _finalStates: Set<string>;
  /** @internal */ readonly _effectSlots: Map<string, EffectSlot>;
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
  get alwaysTransitions(): ReadonlyArray<AlwaysTransition<State, GD, EFD, R>> {
    return this._alwaysTransitions;
  }
  get onEnterEffects(): ReadonlyArray<StateEffect<State, Event, EFD, R>> {
    return this._onEnterEffects;
  }
  get onExitEffects(): ReadonlyArray<StateEffect<State, Event, EFD, R>> {
    return this._onExitEffects;
  }
  get rootInvokes(): ReadonlyArray<RootInvoke<State, Event, R>> {
    return this._rootInvokes;
  }
  get finalStates(): ReadonlySet<string> {
    return this._finalStates;
  }
  get effectSlots(): ReadonlyMap<string, EffectSlot> {
    return this._effectSlots;
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
    this._alwaysTransitions = [];
    this._onEnterEffects = [];
    this._onExitEffects = [];
    this._rootInvokes = [];
    this._finalStates = new Set();
    this._effectSlots = new Map();
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

  // ---- on method with force submethod ----

  get on(): OnMethod<State, Event, R, _Slots, _SD, _ED, GD, EFD> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const machine = this;
    const onFn = function <
      NS extends BrandedState,
      NE extends BrandedEvent,
      RS extends BrandedState,
      R2 = never,
    >(
      state: TaggedOrConstructor<NS>,
      event: TaggedOrConstructor<NE>,
      handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
    ) {
      return machine.addTransition(state, event, handler, false);
    };
    onFn.force = function <
      NS extends BrandedState,
      NE extends BrandedEvent,
      RS extends BrandedState,
      R2 = never,
    >(
      state: TaggedOrConstructor<NS>,
      event: TaggedOrConstructor<NE>,
      handler: TransitionHandler<NS, NE, RS, GD, EFD, R2>,
    ) {
      return machine.addTransition(state, event, handler, true);
    };
    return onFn as unknown as OnMethod<State, Event, R, _Slots, _SD, _ED, GD, EFD>;
  }

  /** @internal */
  private addTransition<NS extends BrandedState, NE extends BrandedEvent, R2>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<NS, NE, BrandedState, GD, EFD, R2>,
    reenter: boolean,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD> {
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

    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
  }

  // ---- always ----

  always<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    handler: (
      state: NS,
      guards: GuardSlots<GD>,
      effects: EffectSlots<EFD>,
    ) => TransitionResult<VariantsUnion<_SD> & BrandedState, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._alwaysTransitions as any[]).push({
      stateTag,
      handler: handler as unknown as AlwaysTransition<State, GD, EFD, R | R2>["handler"],
    });
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
  }

  // ---- invoke ----

  invoke<NS extends VariantsUnion<_SD> & BrandedState, Name extends string>(
    state: TaggedOrConstructor<NS>,
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"invoke", Name>, _SD, _ED, GD, EFD>;

  invoke<NS extends VariantsUnion<_SD> & BrandedState, const Names extends readonly string[]>(
    state: TaggedOrConstructor<NS>,
    names: Names,
  ): Machine<State, Event, R, _Slots | InvokeSlots<Names>, _SD, _ED, GD, EFD>;

  invoke<Name extends string>(
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"invoke", Name>, _SD, _ED, GD, EFD>;

  invoke<const Names extends readonly string[]>(
    names: Names,
  ): Machine<State, Event, R, _Slots | InvokeSlots<Names>, _SD, _ED, GD, EFD>;

  invoke(
    stateOrName: TaggedOrConstructor<BrandedState> | string | readonly string[],
    nameOrNames?: string | readonly string[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    // Root invoke: invoke(name) or invoke([names])
    if (nameOrNames === undefined) {
      const names =
        typeof stateOrName === "string" ? [stateOrName] : (stateOrName as readonly string[]);
      for (const name of names) {
        this._effectSlots.set(name, { type: "invoke", stateTag: null, name });
      }
      return this;
    }

    // State invoke: invoke(state, name) or invoke(state, [names])
    const stateTag = getTag(stateOrName as TaggedOrConstructor<BrandedState>);
    const names = typeof nameOrNames === "string" ? [nameOrNames] : nameOrNames;
    for (const name of names) {
      this._effectSlots.set(name, { type: "invoke", stateTag, name });
    }
    return this;
  }

  // ---- onEnter ----

  onEnter<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, VariantsUnion<_ED> & BrandedEvent, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._onEnterEffects as any[]).push({
      stateTag,
      handler: handler as unknown as StateEffect<State, Event, EFD, R | R2>["handler"],
    });
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
  }

  // ---- onExit ----

  onExit<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    handler: StateEffectHandler<NS, VariantsUnion<_ED> & BrandedEvent, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._onExitEffects as any[]).push({
      stateTag,
      handler: handler as unknown as StateEffect<State, Event, EFD, R | R2>["handler"],
    });
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
  }

  // ---- delay ----

  delay<NS extends VariantsUnion<_SD> & BrandedState, NE extends VariantsUnion<_ED> & BrandedEvent>(
    state: TaggedOrConstructor<NS>,
    duration: DurationOrFn<NS>,
    event: TaggedOrConstructor<NE>,
  ): Machine<State, Event, R, _Slots, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);

    // Create fiber storage for this delay instance
    const getFiberMap = createFiberStorage();
    const delayKey = Symbol("delay");

    // Get event value (if constructor, call it)
    const eventValue = typeof event === "function" ? (event as () => BrandedEvent)() : event;

    // Pre-decode if static duration
    const staticDuration = typeof duration !== "function" ? Duration.decode(duration) : null;

    const enterHandler = (ctx: StateHandlerContext<State, Event, EFD>) => {
      const dur =
        staticDuration ??
        Duration.decode(
          (duration as (s: NS) => Duration.DurationInput)(ctx.state as unknown as NS),
        );
      return Effect.gen(function* () {
        const fiberMap = getFiberMap(ctx.self);
        const fiber = yield* Effect.sleep(dur).pipe(
          Effect.andThen(ctx.self.send(eventValue as Event)),
          Effect.fork,
        );
        fiberMap.set(delayKey, fiber);
      });
    };

    const exitHandler = (ctx: StateHandlerContext<State, Event, EFD>) =>
      Effect.gen(function* () {
        const fiberMap = getFiberMap(ctx.self);
        const fiber = fiberMap.get(delayKey);
        if (fiber !== undefined) {
          fiberMap.delete(delayKey);
          yield* Fiber.interrupt(fiber);
        }
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._onEnterEffects as any[]).push({ stateTag, handler: enterHandler });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._onExitEffects as any[]).push({ stateTag, handler: exitHandler });
    return this;
  }

  // ---- final ----

  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _Slots, _SD, _ED, GD, EFD> {
    const stateTag = getTag(state);
    this._finalStates.add(stateTag);
    return this;
  }

  // ---- provide ----

  provide<R2>(
    handlers: ProvideHandlers<State, Event, GD, EFD, _Slots, R2>,
  ): Machine<State, Event, R | NormalizeR<R2>, never, _SD, _ED, GD, EFD> {
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

    // Legacy effect slots (invoke)
    for (const [name] of this._effectSlots) {
      requiredSlots.add(name);
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
    const result = new Machine<State, Event, R | R2, never, _SD, _ED, GD, EFD>(
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
    (result as any)._alwaysTransitions = this._alwaysTransitions;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result as any)._finalStates = this._finalStates;

    // Copy arrays that will be mutated by provide (add slot handlers)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result._onEnterEffects as any[]).push(...this._onEnterEffects);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result._onExitEffects as any[]).push(...this._onExitEffects);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result._rootInvokes as any[]).push(...this._rootInvokes);

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

    // Handle legacy effect slots (invoke)
    for (const [name, slot] of this._effectSlots) {
      const handler = (
        handlers as Record<
          string,
          (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R2>
        >
      )[name];
      if (handler === undefined) continue;

      if (slot.type === "invoke") {
        if (slot.stateTag === null) {
          // Root-level invoke - runs for entire machine lifetime
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._rootInvokes as any[]).push({
            name,
            handler: handler as (
              ctx: StateEffectContext<State, Event>,
            ) => Effect.Effect<void, never, R | R2>,
          });
        } else {
          // State-scoped invoke - creates onEnter (fork) and onExit (cancel)
          const invokeKey = Symbol(`invoke:${name}`);
          const getFiberMap = createFiberStorage();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._onEnterEffects as any[]).push({
            stateTag: slot.stateTag,
            handler: (ctx: StateHandlerContext<State, Event, EFD>) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.fork(handler({ state: ctx.state, self: ctx.self }));
                getFiberMap(ctx.self).set(invokeKey, fiber);
              }),
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._onExitEffects as any[]).push({
            stateTag: slot.stateTag,
            handler: ({ self }: StateHandlerContext<State, Event, EFD>) =>
              Effect.suspend(() => {
                const fiberMap = getFiberMap(self);
                const fiber = fiberMap.get(invokeKey);
                if (fiber !== undefined) {
                  fiberMap.delete(invokeKey);
                  return Fiber.interrupt(fiber).pipe(Effect.asVoid);
                }
                return Effect.void;
              }),
          });
        }
      }
    }

    // Note: do NOT copy effectSlots to result - they are resolved

    return result as unknown as Machine<State, Event, R | NormalizeR<R2>, never, _SD, _ED, GD, EFD>;
  }

  // ---- from ----

  from<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    build: (
      scope: FromScope<
        NS,
        VariantsUnion<_ED> & BrandedEvent,
        VariantsUnion<_SD> & BrandedState,
        GD,
        EFD
      >,
    ) => FromScope<
      NS,
      VariantsUnion<_ED> & BrandedEvent,
      VariantsUnion<_SD> & BrandedState,
      GD,
      EFD,
      R2
    >,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transitions: Array<{ event: any; handler: any }> = [];

    const scope: FromScope<
      NS,
      VariantsUnion<_ED> & BrandedEvent,
      VariantsUnion<_SD> & BrandedState,
      GD,
      EFD
    > = {
      on(event, handler) {
        transitions.push({ event, handler });
        return scope;
      },
    };

    build(scope);

    for (const t of transitions) {
      this.addTransition(state, t.event, t.handler, false);
    }
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;
  }

  // ---- onAny ----

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    states: [TaggedOrConstructor<S1>, TaggedOrConstructor<S2>],
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<S1 | S2, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    states: [TaggedOrConstructor<S1>, TaggedOrConstructor<S2>, TaggedOrConstructor<S3>],
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<S1 | S2 | S3, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    states: [
      TaggedOrConstructor<S1>,
      TaggedOrConstructor<S2>,
      TaggedOrConstructor<S3>,
      TaggedOrConstructor<S4>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<S1 | S2 | S3 | S4, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    S5 extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    states: [
      TaggedOrConstructor<S1>,
      TaggedOrConstructor<S2>,
      TaggedOrConstructor<S3>,
      TaggedOrConstructor<S4>,
      TaggedOrConstructor<S5>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: TransitionHandler<S1 | S2 | S3 | S4 | S5, NE, RS, GD, EFD, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED, GD, EFD>;

  onAny(
    states: ReadonlyArray<TaggedOrConstructor<BrandedState>>,
    event: TaggedOrConstructor<BrandedEvent>,
    handler: TransitionHandler<BrandedState, BrandedEvent, BrandedState, GD, EFD, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    for (const state of states) {
      this.addTransition(state, event, handler, false);
    }
    return this;
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
  >(config: MakeConfig<SD, ED, S, E, GD, EFD>): Machine<S, E, never, never, SD, ED, GD, EFD> {
    return new Machine<S, E, never, never, SD, ED, GD, EFD>(
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
// Re-export for backward compatibility (will be removed)
// ============================================================================

// Legacy types that are no longer used
export type OnOptions<_S, _E, _R> = object;
export type OnForceOptions<_S, _E, _R> = object;
export type DelayOptions<_S> = object;
export type AlwaysBranch<_S, _R> = object;
export type ChooseBranch<_S, _E, _R> = object;
export type ChooseOtherwise<_S, _E, _R> = object;
export type ChooseEntry<_S, _E, _R> = object;
export type EffectHandler<_S, _E, _R> = object;
export type EffectHandlers<_S, _E, _Slots, _R> = object;
export type GuardHandler<_S, _E, _R> = object;
