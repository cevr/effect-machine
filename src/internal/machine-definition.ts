/**
 * Internal machine definition descriptors.
 *
 * @internal
 */
import type { Guard, StateEffectHandler, TransitionHandler } from "../machine.js";

export interface Transition<State, Event, R> {
  readonly stateTag: string;
  readonly eventTag: string;
  readonly handler: TransitionHandler<State, Event, State, R>;
  readonly reenter?: boolean;
  readonly guard?: Guard<State, Event, unknown>;
}

export interface SpawnEffect<State, Event, R> {
  readonly stateTag: string;
  readonly handler: StateEffectHandler<State, Event, R>;
}

export interface BackgroundEffect<State, Event, R> {
  readonly handler: StateEffectHandler<State, Event, R>;
}
