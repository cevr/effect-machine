/**
 * Effect Atom integration for actors.
 *
 * The adapter keeps the actor as the state owner. Atom registries observe the
 * actor's SubscriptionRef and write events through its synchronous boundary.
 */
import { dual } from "effect/Function";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import type { ActorLifecycle, ActorRef, TransitionInfo } from "./actor.js";

/**
 * A writable Atom projection of an actor.
 *
 * The Atom value is the current actor state. Atom writes send actor events.
 */
export type ActorAtom<State, Event> = Atom.Writable<State, Event>;

/**
 * Make a writable Atom from an actor.
 *
 * The actor stays the single state owner. The Atom follows recovery,
 * supervision restarts, and normal transitions through the actor's
 * SubscriptionRef.
 */
export const make = <State extends { readonly _tag: string }, Event, Output>(
  actor: ActorRef<State, Event, Output>,
): ActorAtom<State, Event> => {
  const state = Atom.subscriptionRef(actor.state);
  return Atom.writable(
    (get) => get(state),
    (_ctx, event) => actor.sync.send(event),
  );
};

/**
 * Select part of an actor state.
 *
 * The selected Atom stays writable. Writes still send events to the actor.
 * The equality function controls when Atom subscribers receive a new value.
 */
export const select: {
  <State, Selection>(
    selector: (state: State) => Selection,
    equals?: (value: Selection, next: Selection) => boolean,
  ): <Event>(self: ActorAtom<State, Event>) => ActorAtom<Selection, Event>;
  <State, Event, Selection>(
    self: ActorAtom<State, Event>,
    selector: (state: State) => Selection,
    equals?: (value: Selection, next: Selection) => boolean,
  ): ActorAtom<Selection, Event>;
} = dual(
  (args) => Atom.isAtom(args[0]),
  <State, Event, Selection>(
    self: ActorAtom<State, Event>,
    selector: (state: State) => Selection,
    equals: (value: Selection, next: Selection) => boolean = Object.is,
  ): ActorAtom<Selection, Event> => Atom.withEquality(Atom.map(self, selector), equals),
);

/** Observe actor lifecycle without coupling it to domain state. */
export const lifecycle = <State extends { readonly _tag: string }, Event, Output>(
  actor: ActorRef<State, Event, Output>,
): Atom.Atom<ActorLifecycle<State, Output>> => Atom.subscriptionRef(actor.lifecycle);

/** Observe the latest accepted edge. The value remains after actor exit. */
export const latestTransition = <State extends { readonly _tag: string }, Event, Output>(
  actor: ActorRef<State, Event, Output>,
): Atom.Atom<TransitionInfo<State, Event> | undefined> =>
  Atom.subscriptionRef(actor.latestTransition);

/** A reactive result for whether an actor can accept one event. */
export type CanAtom = Atom.Atom<AsyncResult.AsyncResult<boolean>>;

/**
 * Observe whether an event has an enabled transition.
 *
 * The Atom reevaluates after each actor state change. It supports pure and
 * Effect predicates. Effect predicates use the context captured by the actor.
 */
export const can: {
  <Event>(
    event: Event,
  ): <State extends { readonly _tag: string }, Output>(
    actor: ActorRef<State, Event, Output>,
  ) => CanAtom;
  <State extends { readonly _tag: string }, Event, Output>(
    actor: ActorRef<State, Event, Output>,
    event: Event,
  ): CanAtom;
} = dual(
  2,
  <State extends { readonly _tag: string }, Event, Output>(
    actor: ActorRef<State, Event, Output>,
    event: Event,
  ): CanAtom => {
    const state = Atom.subscriptionRef(actor.state);
    return Atom.make((get) => {
      get(state);
      return actor.can(event);
    }).pipe(
      Atom.withEquality<AsyncResult.AsyncResult<boolean>>(
        (value, next) =>
          AsyncResult.isSuccess(value) &&
          AsyncResult.isSuccess(next) &&
          Object.is(value.value, next.value),
      ),
    );
  },
);
