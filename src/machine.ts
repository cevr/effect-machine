import type { Schema, Schedule } from "effect";
import { Duration, Effect, Fiber } from "effect";
import type { Pipeable } from "effect/Pipeable";
import { pipeArguments } from "effect/Pipeable";
import { createFiberStorage } from "./internal/fiber-storage.js";

import type {
  Guard,
  GuardInput,
  StateEffectContext,
  TransitionContext,
  TransitionResult,
} from "./internal/types.js";
import { normalizeGuard } from "./internal/types.js";
import type { TaggedOrConstructor, BrandedState, BrandedEvent } from "./internal/brands.js";
import { getTag } from "./internal/get-tag.js";
import type { MachineStateSchema, MachineEventSchema, VariantsUnion } from "./machine-schema.js";
import type { PersistentMachine, WithPersistenceConfig } from "./persistence/persistent-machine.js";
import { persist as persistImpl } from "./persistence/persistent-machine.js";
import { MissingSlotHandlerError, UnknownSlotError } from "./errors.js";

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
 * Transition definition
 */
export interface Transition<State, Event, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: (ctx: TransitionContext<State, Event>) => TransitionResult<State, R>;
  /** Guard display name */
  readonly guardName?: string;
  /** Guard tree for evaluation */
  readonly guard?: Guard<State, Event, R>;
  readonly effect?: (ctx: TransitionContext<State, Event>) => Effect.Effect<void, never, R>;
  readonly reenter?: boolean;
}

/**
 * Always (eventless) transition definition
 */
export interface AlwaysTransition<State, R> {
  readonly stateTag: string;
  readonly handler: (state: State) => TransitionResult<State, R>;
  readonly guard?: (state: State) => boolean;
}

/**
 * Entry/exit effect definition
 */
export interface StateEffect<State, Event, R> {
  readonly stateTag: string;
  readonly handler: (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R>;
}

/**
 * Root invoke effect - runs for entire machine lifetime
 */
export interface RootInvoke<State, Event, R> {
  readonly name: string;
  readonly handler: (ctx: StateEffectContext<State, Event>) => Effect.Effect<void, never, R>;
}

/**
 * Effect slot - named slot for effect provision
 */
export type EffectSlot =
  | { readonly type: "invoke"; readonly stateTag: string | null; readonly name: string }
  | { readonly type: "onEnter"; readonly stateTag: string; readonly name: string }
  | { readonly type: "onExit"; readonly stateTag: string; readonly name: string }
  | {
      readonly type: "guard";
      readonly stateTag: string;
      readonly eventTag: string;
      readonly name: string;
    };

/**
 * Type-level effect slot for phantom type tracking
 */
export type EffectSlotType<
  Type extends "invoke" | "onEnter" | "onExit" | "guard",
  Name extends string,
> = { readonly type: Type; readonly name: Name };

/** Any effect slot type (for constraints) */
export type AnySlot = EffectSlotType<"invoke" | "onEnter" | "onExit" | "guard", string>;

// ============================================================================
// Options types
// ============================================================================

/** Options for `on` transitions */
export interface OnOptions<S, E, R> {
  readonly guard?: GuardInput<S, E>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
}

/** Options for `on.force` (reenter is always true) */
export interface OnForceOptions<S, E, R> {
  readonly guard?: GuardInput<S, E>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
}

/** Options for `delay` */
export interface DelayOptions<S> {
  readonly guard?: (state: S) => boolean;
}

/** Duration input for delay */
export type DurationOrFn<S> = Duration.DurationInput | ((state: S) => Duration.DurationInput);

/** Options for `persist` */
export interface PersistOptions {
  readonly snapshotSchedule: Schedule.Schedule<unknown, { readonly _tag: string }>;
  readonly journalEvents: boolean;
  readonly machineType?: string;
}

/** Branch for `always` transitions */
export interface AlwaysBranch<S, R> {
  readonly guard?: (state: S) => boolean;
  readonly to: (state: S) => TransitionResult<{ readonly _tag: string }, R>;
}

/** Branch for `choose` transitions (with guard) */
export interface ChooseBranch<S, E, R> {
  readonly guard: GuardInput<S, E, R>;
  readonly to: (ctx: TransitionContext<S, E>) => TransitionResult<{ readonly _tag: string }, R>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  readonly otherwise?: never;
}

/** Fallback branch for `choose` (no guard) */
export interface ChooseOtherwise<S, E, R> {
  readonly otherwise: true;
  readonly to: (ctx: TransitionContext<S, E>) => TransitionResult<{ readonly _tag: string }, R>;
  readonly effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  readonly guard?: never;
}

/** Entry type for choose branches */
export type ChooseEntry<S, E, R> = ChooseBranch<S, E, R> | ChooseOtherwise<S, E, R>;

// ============================================================================
// Effect handler types
// ============================================================================

/** Effect handler function */
export type EffectHandler<State, Event, R> = (
  ctx: StateEffectContext<State, Event>,
) => Effect.Effect<void, never, R>;

/** Guard handler function - sync boolean or Effect<boolean> */
export type GuardHandler<State, Event, R = never> = (
  ctx: TransitionContext<State, Event>,
) => boolean | Effect.Effect<boolean, never, R>;

/** Compute handler type based on slot type */
type HandlerForSlot<State, Event, Slot extends AnySlot, R> = Slot extends { type: "guard" }
  ? GuardHandler<State, Event, R>
  : EffectHandler<State, Event, R>;

/** Type for the handlers record */
export type EffectHandlers<State, Event, Slots extends AnySlot, R> = {
  [K in Slots["name"]]: HandlerForSlot<State, Event, Extract<Slots, { name: K }>, R>;
};

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

interface NormalizedGuardOptions<S, E, R> {
  guardName?: string;
  guardSlotNames?: readonly string[];
  guard?: Guard<S, E, R>;
  effect?: (ctx: TransitionContext<S, E>) => Effect.Effect<void, never, R>;
  reenter?: boolean;
}

const normalizeOnOptions = <S, E, R>(
  options?: OnOptions<S, E, R>,
  reenter?: boolean,
): NormalizedGuardOptions<S, E, R> | undefined => {
  if (options === undefined && reenter === undefined) return undefined;

  const result: NormalizedGuardOptions<S, E, R> = { reenter };

  if (options?.guard !== undefined) {
    const normalized = normalizeGuard(options.guard);
    result.guardName = normalized.name;
    result.guardSlotNames = normalized.slotNames;
    result.guard = normalized.guard;
  }

  result.effect = options?.effect;
  return result;
};

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
  R = never,
> {
  on<NE extends EventUnion, RS extends StateUnion, R2 = never>(
    event: TaggedOrConstructor<NE>,
    handler: (ctx: TransitionContext<NarrowedState, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<NarrowedState, NE, R2>,
  ): FromScope<NarrowedState, EventUnion, StateUnion, R | R2>;
}

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
> {
  <
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: (ctx: TransitionContext<NS, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<NS, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  force: OnForceMethod<State, Event, R, _Slots, _SD, _ED>;
}

/** The `on.force` method interface */
export interface OnForceMethod<
  State,
  Event,
  R,
  _Slots extends AnySlot,
  _SD extends Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields>,
> {
  <
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    RS extends VariantsUnion<_SD> & BrandedState,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: (ctx: TransitionContext<NS, NE>) => TransitionResult<RS, R2>,
    options?: OnForceOptions<NS, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;
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
 * - `_Slots`: Phantom type tracking unprovided effect slots
 * - `_SD`: State schema definition (for compile-time validation)
 * - `_ED`: Event schema definition (for compile-time validation)
 */
export class Machine<
  State,
  Event,
  R = never,
  _Slots extends AnySlot = never,
  _SD extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
  _ED extends Record<string, Schema.Struct.Fields> = Record<string, Schema.Struct.Fields>,
> implements Pipeable {
  readonly initial: State;
  /** @internal */ readonly _transitions: Array<Transition<State, Event, R>>;
  /** @internal */ readonly _alwaysTransitions: Array<AlwaysTransition<State, R>>;
  /** @internal */ readonly _onEnterEffects: Array<StateEffect<State, Event, R>>;
  /** @internal */ readonly _onExitEffects: Array<StateEffect<State, Event, R>>;
  /** @internal */ readonly _rootInvokes: Array<RootInvoke<State, Event, R>>;
  /** @internal */ readonly _finalStates: Set<string>;
  /** @internal */ readonly _effectSlots: Map<string, EffectSlot>;
  /** @internal */ readonly _guardHandlers: Map<string, GuardHandler<State, Event, R>>;
  readonly stateSchema?: Schema.Schema<State, unknown, never>;
  readonly eventSchema?: Schema.Schema<Event, unknown, never>;

  // Public readonly views
  get transitions(): ReadonlyArray<Transition<State, Event, R>> {
    return this._transitions;
  }
  get alwaysTransitions(): ReadonlyArray<AlwaysTransition<State, R>> {
    return this._alwaysTransitions;
  }
  get onEnterEffects(): ReadonlyArray<StateEffect<State, Event, R>> {
    return this._onEnterEffects;
  }
  get onExitEffects(): ReadonlyArray<StateEffect<State, Event, R>> {
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
  get guardHandlers(): ReadonlyMap<string, GuardHandler<State, Event, R>> {
    return this._guardHandlers;
  }

  /** @internal */
  constructor(
    initial: State,
    stateSchema?: Schema.Schema<State, unknown, never>,
    eventSchema?: Schema.Schema<Event, unknown, never>,
  ) {
    this.initial = initial;
    this._transitions = [];
    this._alwaysTransitions = [];
    this._onEnterEffects = [];
    this._onExitEffects = [];
    this._rootInvokes = [];
    this._finalStates = new Set();
    this._effectSlots = new Map();
    this._guardHandlers = new Map();
    this.stateSchema = stateSchema;
    this.eventSchema = eventSchema;
  }

  pipe() {
    // eslint-disable-next-line prefer-rest-params
    return pipeArguments(this, arguments);
  }

  // ---- on method with force submethod ----

  get on(): OnMethod<State, Event, R, _Slots, _SD, _ED> {
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
      handler: (ctx: TransitionContext<NS, NE>) => TransitionResult<RS, R2>,
      options?: OnOptions<NS, NE, R2>,
    ) {
      return machine.addTransition(state, event, handler, options, false);
    };
    onFn.force = function <
      NS extends BrandedState,
      NE extends BrandedEvent,
      RS extends BrandedState,
      R2 = never,
    >(
      state: TaggedOrConstructor<NS>,
      event: TaggedOrConstructor<NE>,
      handler: (ctx: TransitionContext<NS, NE>) => TransitionResult<RS, R2>,
      options?: OnForceOptions<NS, NE, R2>,
    ) {
      return machine.addTransition(state, event, handler, options as OnOptions<NS, NE, R2>, true);
    };
    return onFn as unknown as OnMethod<State, Event, R, _Slots, _SD, _ED>;
  }

  /** @internal */
  private addTransition<NS extends BrandedState, NE extends BrandedEvent, R2>(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    handler: (ctx: TransitionContext<NS, NE>) => TransitionResult<BrandedState, R2>,
    options: OnOptions<NS, NE, R2> | undefined,
    reenter: boolean,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);
    const normalized = normalizeOnOptions(options, reenter);

    const transition: Transition<State, Event, R | R2> = {
      stateTag,
      eventTag,
      handler: handler as unknown as Transition<State, Event, R | R2>["handler"],
      guardName: normalized?.guardName,
      guard: normalized?.guard as unknown as Transition<State, Event, R | R2>["guard"],
      effect: normalized?.effect as unknown as Transition<State, Event, R | R2>["effect"],
      reenter: normalized?.reenter,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this._transitions as any[]).push(transition);

    // Register all guard slots (for composed guards, register each constituent)
    if (normalized?.guardSlotNames !== undefined) {
      for (const slotName of normalized.guardSlotNames) {
        this._effectSlots.set(slotName, {
          type: "guard",
          stateTag,
          eventTag,
          name: slotName,
        });
      }
    }

    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED>;
  }

  // ---- always ----

  always<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    branches: ReadonlyArray<AlwaysBranch<NS, R2>>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED> {
    const stateTag = getTag(state);
    for (const branch of branches) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._alwaysTransitions as any[]).push({
        stateTag,
        handler: branch.to as unknown as AlwaysTransition<State, R | R2>["handler"],
        guard: branch.guard as unknown as AlwaysTransition<State, R | R2>["guard"],
      });
    }
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED>;
  }

  // ---- choose ----

  choose<
    NS extends VariantsUnion<_SD> & BrandedState,
    NE extends VariantsUnion<_ED> & BrandedEvent,
    R2 = never,
  >(
    state: TaggedOrConstructor<NS>,
    event: TaggedOrConstructor<NE>,
    branches: ReadonlyArray<ChooseEntry<NS, NE, R2>>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED> {
    const stateTag = getTag(state);
    const eventTag = getTag(event);
    for (const branch of branches) {
      const hasGuard = !("otherwise" in branch && branch.otherwise === true);
      const guardInput = hasGuard ? (branch as ChooseBranch<NS, NE, R2>).guard : undefined;
      const normalized = guardInput !== undefined ? normalizeGuard(guardInput) : undefined;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this._transitions as any[]).push({
        stateTag,
        eventTag,
        handler: branch.to as unknown as Transition<State, Event, R | R2>["handler"],
        guardName: normalized?.name,
        guard: normalized?.guard,
        effect: branch.effect as unknown as Transition<State, Event, R | R2>["effect"],
      });

      // Register guard slots
      if (normalized?.slotNames !== undefined) {
        for (const slotName of normalized.slotNames) {
          this._effectSlots.set(slotName, {
            type: "guard",
            stateTag,
            eventTag,
            name: slotName,
          });
        }
      }
    }
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED>;
  }

  // ---- invoke ----

  invoke<NS extends VariantsUnion<_SD> & BrandedState, Name extends string>(
    state: TaggedOrConstructor<NS>,
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"invoke", Name>, _SD, _ED>;

  invoke<NS extends VariantsUnion<_SD> & BrandedState, const Names extends readonly string[]>(
    state: TaggedOrConstructor<NS>,
    names: Names,
  ): Machine<State, Event, R, _Slots | InvokeSlots<Names>, _SD, _ED>;

  invoke<Name extends string>(
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"invoke", Name>, _SD, _ED>;

  invoke<const Names extends readonly string[]>(
    names: Names,
  ): Machine<State, Event, R, _Slots | InvokeSlots<Names>, _SD, _ED>;

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

  onEnter<NS extends VariantsUnion<_SD> & BrandedState, Name extends string>(
    state: TaggedOrConstructor<NS>,
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"onEnter", Name>, _SD, _ED> {
    const stateTag = getTag(state);
    this._effectSlots.set(name, { type: "onEnter", stateTag, name });
    return this as unknown as Machine<
      State,
      Event,
      R,
      _Slots | EffectSlotType<"onEnter", Name>,
      _SD,
      _ED
    >;
  }

  // ---- onExit ----

  onExit<NS extends VariantsUnion<_SD> & BrandedState, Name extends string>(
    state: TaggedOrConstructor<NS>,
    name: Name,
  ): Machine<State, Event, R, _Slots | EffectSlotType<"onExit", Name>, _SD, _ED> {
    const stateTag = getTag(state);
    this._effectSlots.set(name, { type: "onExit", stateTag, name });
    return this as unknown as Machine<
      State,
      Event,
      R,
      _Slots | EffectSlotType<"onExit", Name>,
      _SD,
      _ED
    >;
  }

  // ---- delay ----

  delay<NS extends VariantsUnion<_SD> & BrandedState, NE extends VariantsUnion<_ED> & BrandedEvent>(
    state: TaggedOrConstructor<NS>,
    duration: DurationOrFn<NS>,
    event: TaggedOrConstructor<NE>,
    options?: DelayOptions<NS>,
  ): Machine<State, Event, R, _Slots, _SD, _ED> {
    const stateTag = getTag(state);

    // Create fiber storage for this delay instance
    const getFiberMap = createFiberStorage();
    const delayKey = Symbol("delay");

    // Get event value (if constructor, call it)
    const eventValue = typeof event === "function" ? (event as () => BrandedEvent)() : event;

    // Pre-decode if static duration
    const staticDuration = typeof duration !== "function" ? Duration.decode(duration) : null;

    const enterHandler = (ctx: StateEffectContext<State, Event>) => {
      if (options?.guard !== undefined && !options.guard(ctx.state as unknown as NS)) {
        return Effect.void;
      }
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

    const exitHandler = (ctx: StateEffectContext<State, Event>) =>
      Effect.gen(function* () {
        const fiberMap = getFiberMap(ctx.self);
        const fiber = fiberMap.get(delayKey);
        if (fiber !== undefined) {
          fiberMap.delete(delayKey);
          yield* Fiber.interrupt(fiber);
        }
      });

    this._onEnterEffects.push({ stateTag, handler: enterHandler });
    this._onExitEffects.push({ stateTag, handler: exitHandler });
    return this;
  }

  // ---- final ----

  final<NS extends VariantsUnion<_SD> & BrandedState>(
    state: TaggedOrConstructor<NS>,
  ): Machine<State, Event, R, _Slots, _SD, _ED> {
    const stateTag = getTag(state);
    this._finalStates.add(stateTag);
    return this;
  }

  // ---- provide ----

  provide<R2>(
    handlers: EffectHandlers<State, Event, _Slots, R2>,
  ): Machine<State, Event, R | NormalizeR<R2>, never, _SD, _ED> {
    // Validate all slots have handlers
    for (const [name] of this._effectSlots) {
      if (!(name in handlers)) {
        throw new MissingSlotHandlerError({ slotName: name });
      }
    }

    // Validate no extra handlers
    for (const name of Object.keys(handlers)) {
      if (!this._effectSlots.has(name)) {
        throw new UnknownSlotError({ slotName: name });
      }
    }

    // Create new machine to preserve original for reuse with different providers
    const result = new Machine<State, Event, R | R2, never, _SD, _ED>(
      this.initial,
      this.stateSchema as Schema.Schema<State, unknown, never>,
      this.eventSchema as Schema.Schema<Event, unknown, never>,
    );

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
    for (const [k, v] of this._guardHandlers)
      result._guardHandlers.set(k, v as GuardHandler<State, Event, R | R2>);
    // Note: do NOT copy effectSlots - they will be resolved below

    for (const [name, slot] of this._effectSlots) {
      const handler = (handlers as Record<string, EffectHandler<State, Event, R2>>)[name];

      if (slot.type === "guard") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result._guardHandlers as Map<string, any>).set(
          name,
          handler as unknown as GuardHandler<State, Event, R | R2>,
        );
      } else if (slot.type === "onEnter") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result._onEnterEffects as any[]).push({
          stateTag: slot.stateTag,
          handler: handler as EffectHandler<State, Event, R | R2>,
        });
      } else if (slot.type === "onExit") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (result._onExitEffects as any[]).push({
          stateTag: slot.stateTag,
          handler: handler as EffectHandler<State, Event, R | R2>,
        });
      } else if (slot.type === "invoke") {
        const effectHandler = handler as EffectHandler<State, Event, R2>;
        if (slot.stateTag === null) {
          // Root-level invoke - runs for entire machine lifetime
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._rootInvokes as any[]).push({
            name,
            handler: effectHandler as EffectHandler<State, Event, R | R2>,
          });
        } else {
          // State-scoped invoke - creates onEnter (fork) and onExit (cancel)
          const invokeKey = Symbol(`invoke:${name}`);
          const getFiberMap = createFiberStorage();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._onEnterEffects as any[]).push({
            stateTag: slot.stateTag,
            handler: (ctx: StateEffectContext<State, Event>) =>
              Effect.gen(function* () {
                const fiber = yield* Effect.fork(effectHandler(ctx));
                getFiberMap(ctx.self).set(invokeKey, fiber);
              }),
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (result._onExitEffects as any[]).push({
            stateTag: slot.stateTag,
            handler: ({ self }: StateEffectContext<State, Event>) =>
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

    return result as unknown as Machine<State, Event, R | NormalizeR<R2>, never, _SD, _ED>;
  }

  // ---- from ----

  from<NS extends VariantsUnion<_SD> & BrandedState, R2 = never>(
    state: TaggedOrConstructor<NS>,
    build: (
      scope: FromScope<NS, VariantsUnion<_ED> & BrandedEvent, VariantsUnion<_SD> & BrandedState>,
    ) => FromScope<NS, VariantsUnion<_ED> & BrandedEvent, VariantsUnion<_SD> & BrandedState, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transitions: Array<{ event: any; handler: any; options?: any }> = [];

    const scope: FromScope<
      NS,
      VariantsUnion<_ED> & BrandedEvent,
      VariantsUnion<_SD> & BrandedState
    > = {
      on(event, handler, options) {
        transitions.push({ event, handler, options });
        return scope;
      },
    };

    build(scope);

    for (const t of transitions) {
      this.addTransition(state, t.event, t.handler, t.options, false);
    }
    return this as unknown as Machine<State, Event, R | R2, _Slots, _SD, _ED>;
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
    handler: (ctx: TransitionContext<S1 | S2, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

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
    handler: (ctx: TransitionContext<S1 | S2 | S3, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

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
    handler: (ctx: TransitionContext<S1 | S2 | S3 | S4, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

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
    handler: (ctx: TransitionContext<S1 | S2 | S3 | S4 | S5, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4 | S5, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    S5 extends VariantsUnion<_SD> & BrandedState,
    S6 extends VariantsUnion<_SD> & BrandedState,
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
      TaggedOrConstructor<S6>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: (ctx: TransitionContext<S1 | S2 | S3 | S4 | S5 | S6, NE>) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4 | S5 | S6, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    S5 extends VariantsUnion<_SD> & BrandedState,
    S6 extends VariantsUnion<_SD> & BrandedState,
    S7 extends VariantsUnion<_SD> & BrandedState,
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
      TaggedOrConstructor<S6>,
      TaggedOrConstructor<S7>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: (
      ctx: TransitionContext<S1 | S2 | S3 | S4 | S5 | S6 | S7, NE>,
    ) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4 | S5 | S6 | S7, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    S5 extends VariantsUnion<_SD> & BrandedState,
    S6 extends VariantsUnion<_SD> & BrandedState,
    S7 extends VariantsUnion<_SD> & BrandedState,
    S8 extends VariantsUnion<_SD> & BrandedState,
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
      TaggedOrConstructor<S6>,
      TaggedOrConstructor<S7>,
      TaggedOrConstructor<S8>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: (
      ctx: TransitionContext<S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8, NE>,
    ) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  onAny<
    S1 extends VariantsUnion<_SD> & BrandedState,
    S2 extends VariantsUnion<_SD> & BrandedState,
    S3 extends VariantsUnion<_SD> & BrandedState,
    S4 extends VariantsUnion<_SD> & BrandedState,
    S5 extends VariantsUnion<_SD> & BrandedState,
    S6 extends VariantsUnion<_SD> & BrandedState,
    S7 extends VariantsUnion<_SD> & BrandedState,
    S8 extends VariantsUnion<_SD> & BrandedState,
    S9 extends VariantsUnion<_SD> & BrandedState,
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
      TaggedOrConstructor<S6>,
      TaggedOrConstructor<S7>,
      TaggedOrConstructor<S8>,
      TaggedOrConstructor<S9>,
    ],
    event: TaggedOrConstructor<NE>,
    handler: (
      ctx: TransitionContext<S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9, NE>,
    ) => TransitionResult<RS, R2>,
    options?: OnOptions<S1 | S2 | S3 | S4 | S5 | S6 | S7 | S8 | S9, NE, R2>,
  ): Machine<State, Event, R | R2, _Slots, _SD, _ED>;

  onAny(
    states: ReadonlyArray<TaggedOrConstructor<BrandedState>>,
    event: TaggedOrConstructor<BrandedEvent>,
    handler: (
      ctx: TransitionContext<BrandedState, BrandedEvent>,
    ) => TransitionResult<BrandedState, unknown>,
    options?: OnOptions<BrandedState, BrandedEvent, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    for (const state of states) {
      this.addTransition(state, event, handler, options, false);
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

  // ---- Static factory ----

  static make<
    SD extends Record<string, Schema.Struct.Fields>,
    ED extends Record<string, Schema.Struct.Fields>,
    S extends BrandedState,
    E extends BrandedEvent,
  >(config: MakeConfig<SD, ED, S, E>): Machine<S, E, never, never, SD, ED> {
    return new Machine<S, E, never, never, SD, ED>(
      config.initial,
      config.state as unknown as Schema.Schema<S, unknown, never>,
      config.event as unknown as Schema.Schema<E, unknown, never>,
    );
  }
}

// ============================================================================
// make function (alias for Machine.make)
// ============================================================================

export const make = Machine.make;
