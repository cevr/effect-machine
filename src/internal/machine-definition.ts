/**
 * Internal machine definition descriptors.
 *
 * @internal
 */
import type {
  GuardPredicate,
  StateEffectDefinition,
  StateEffectHandler,
  TransitionHandler,
} from "../machine.js";

export interface Transition<State, Event, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: TransitionHandler<State, Event, State, R>;
  readonly reenter?: boolean;
  readonly guard?: GuardPredicate<State, Event, never>;
}

export interface SpawnEffect<State, Event, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, R>;
  /** The builder method that registered the effect. `task` and `timeout` wrap their handler. */
  readonly method: StateEffectDefinition["method"];
  /** Spawn handler name, task name, or `$timeout:<StateTag>`. */
  readonly name: string | undefined;
}

export interface BackgroundEffect<State, Event, R> {
  readonly handler: StateEffectHandler<State, Event, R>;
}
