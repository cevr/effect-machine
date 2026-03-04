import { EffectsDef, GuardsDef } from "../slot.js";
import { BuiltMachine, Machine, MachineRef, SpawnEffect, Transition } from "../machine.js";
import { ActorSystem } from "../actor.js";
import { Cause, Effect, Scope } from "effect";

//#region src-v3/internal/transition.d.ts
/**
 * Result of executing a transition.
 */
interface TransitionExecutionResult<S> {
  /** New state after transition (or current state if no transition matched) */
  readonly newState: S;
  /** Whether a transition was executed */
  readonly transitioned: boolean;
  /** Whether reenter was specified on the transition */
  readonly reenter: boolean;
}
/**
 * Run a transition handler and return the new state.
 * Shared logic for executing handlers with proper context.
 *
 * Used by:
 * - executeTransition (actor event loop, testing)
 * - persistent-actor replay (restore, replayTo)
 *
 * @internal
 */
declare const runTransitionHandler: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  transition: Transition<S, E, GD, EFD, R>,
  state: S,
  event: E,
  self: MachineRef<E>,
  system: ActorSystem,
) => Effect.Effect<S, never, Exclude<R, unknown>>;
/**
 * Execute a transition for a given state and event.
 * Handles transition resolution, handler invocation, and guard/effect slot creation.
 *
 * Used by:
 * - processEvent in actor.ts (actual actor event loop)
 * - simulate in testing.ts (pure transition simulation)
 * - createTestHarness.send in testing.ts (step-by-step testing)
 *
 * @internal
 */
declare const executeTransition: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  system: ActorSystem,
) => Effect.Effect<
  {
    newState: S;
    transitioned: boolean;
    reenter: boolean;
  },
  never,
  Exclude<R, unknown>
>;
/**
 * Optional hooks for event processing inspection/tracing.
 */
interface ProcessEventHooks<S, E> {
  /** Called before running spawn effects */
  readonly onSpawnEffect?: (state: S) => Effect.Effect<void>;
  /** Called after transition completes */
  readonly onTransition?: (from: S, to: S, event: E) => Effect.Effect<void>;
  /** Called when a transition handler or spawn effect fails with a defect */
  readonly onError?: (info: ProcessEventError<S, E>) => Effect.Effect<void>;
}
/**
 * Error info for inspection hooks.
 */
interface ProcessEventError<S, E> {
  readonly phase: "transition" | "spawn";
  readonly state: S;
  readonly event: E;
  readonly cause: Cause.Cause<unknown>;
}
/**
 * Result of processing an event through the machine.
 */
interface ProcessEventResult<S> {
  /** New state after processing */
  readonly newState: S;
  /** Previous state before processing */
  readonly previousState: S;
  /** Whether a transition occurred */
  readonly transitioned: boolean;
  /** Whether lifecycle effects ran (state change or reenter) */
  readonly lifecycleRan: boolean;
  /** Whether new state is final */
  readonly isFinal: boolean;
}
/**
 * Process a single event through the machine.
 *
 * Handles:
 * - Transition execution
 * - State scope lifecycle (close old, create new)
 * - Running spawn effects
 *
 * Optional hooks allow inspection/tracing without coupling to specific impl.
 *
 * @internal
 */
declare const processEventCore: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  currentState: S,
  event: E,
  self: MachineRef<E>,
  stateScopeRef: {
    current: Scope.CloseableScope;
  },
  system: ActorSystem,
  hooks?: ProcessEventHooks<S, E> | undefined,
) => Effect.Effect<
  {
    newState: any;
    previousState: S;
    transitioned: boolean;
    lifecycleRan: any;
    isFinal: boolean;
  },
  unknown,
  unknown
>;
/**
 * Run spawn effects for a state (forked into state scope, auto-cancelled on state exit).
 *
 * @internal
 */
declare const runSpawnEffects: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef,
  EFD extends EffectsDef,
>(
  machine: Machine<S, E, R, Record<string, never>, Record<string, never>, GD, EFD>,
  state: S,
  event: E,
  self: MachineRef<E>,
  stateScope: Scope.CloseableScope,
  system: ActorSystem,
  onError?: ((info: ProcessEventError<S, E>) => Effect.Effect<void>) | undefined,
) => Effect.Effect<void, never, unknown>;
/**
 * Resolve which transition should fire for a given state and event.
 * Uses indexed O(1) lookup. First matching transition wins.
 */
declare const resolveTransition: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
>(
  machine: Machine<S, E, R, any, any, any, any>,
  currentState: S,
  event: E,
) => (typeof machine.transitions)[number] | undefined;
/**
 * Invalidate cached index for a machine (call after mutation).
 */
declare const invalidateIndex: (machine: object) => void;
/**
 * Find all transitions matching a state/event pair.
 * Returns empty array if no matches.
 *
 * Accepts both `Machine` and `BuiltMachine`.
 * O(1) lookup after first access (index is lazily built).
 */
declare const findTransitions: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  input: Machine<S, E, R, any, any, GD, EFD> | BuiltMachine<S, E, R>,
  stateTag: string,
  eventTag: string,
) => ReadonlyArray<Transition<S, E, GD, EFD, R>>;
/**
 * Find all spawn effects for a state.
 * Returns empty array if no matches.
 *
 * O(1) lookup after first access (index is lazily built).
 */
declare const findSpawnEffects: <
  S extends {
    readonly _tag: string;
  },
  E extends {
    readonly _tag: string;
  },
  R,
  GD extends GuardsDef = Record<string, never>,
  EFD extends EffectsDef = Record<string, never>,
>(
  machine: Machine<S, E, R, any, any, GD, EFD>,
  stateTag: string,
) => ReadonlyArray<SpawnEffect<S, E, EFD, R>>;
//#endregion
export {
  ProcessEventError,
  ProcessEventHooks,
  ProcessEventResult,
  TransitionExecutionResult,
  executeTransition,
  findSpawnEffects,
  findTransitions,
  invalidateIndex,
  processEventCore,
  resolveTransition,
  runSpawnEffects,
  runTransitionHandler,
};
