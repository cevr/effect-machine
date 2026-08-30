import { Effect, Schema } from "effect";
import * as Atom from "effect/unstable/reactivity/Atom";
import type { ActorRef } from "effect-machine";
import { Event, Machine, State } from "effect-machine";
import * as ActorAtom from "effect-machine/atom";

export const CounterState = State({
  Active: { count: Schema.Finite, label: Schema.String },
  Done: { count: Schema.Finite, label: Schema.String },
});
export type CounterState = typeof CounterState.Type;
export type CounterOutput = Extract<CounterState, { readonly _tag: "Done" }>;

export const CounterEvent = Event({
  Increment: {},
  Rename: { label: Schema.String },
  Finish: {},
});
export type CounterEvent = typeof CounterEvent.Type;

const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Active({ count: 0, label: "Counter" }),
})
  .when(
    CounterState.Active,
    CounterEvent.Increment,
    ({ state }) => state.count < 2,
    ({ state }) => CounterState.Active.with(state, { count: state.count + 1 }),
  )
  .on(CounterState.Active, CounterEvent.Rename, ({ state, event }) =>
    CounterState.Active.with(state, { label: event.label }),
  )
  .on(CounterState.Active, CounterEvent.Finish, ({ state }) => CounterState.Done.with(state))
  .final(CounterState.Done);

export const spawnCounter: Effect.Effect<ActorRef<CounterState, CounterEvent, CounterOutput>> =
  Machine.spawn(counterMachine).pipe(Effect.tap((actor) => actor.start));

export const makeCounterActorAtom = () => Atom.make(Machine.scoped(spawnCounter));
export type CounterActorAtom = ReturnType<typeof makeCounterActorAtom>;

export interface CounterAtoms {
  readonly state: ActorAtom.ActorAtom<CounterState, CounterEvent>;
  readonly count: ActorAtom.ActorAtom<number, CounterEvent>;
  readonly label: ActorAtom.ActorAtom<string, CounterEvent>;
  readonly status: ActorAtom.ActorAtom<CounterState["_tag"], CounterEvent>;
  readonly canIncrement: ActorAtom.CanAtom;
}

export const makeCounterAtoms = (
  actor: ActorRef<CounterState, CounterEvent, CounterOutput>,
): CounterAtoms => {
  const state = ActorAtom.make(actor);
  return {
    state,
    count: ActorAtom.select(state, (value) => value.count),
    label: ActorAtom.select(state, (value) => value.label),
    status: ActorAtom.select(state, (value) => value._tag),
    canIncrement: ActorAtom.can(actor, CounterEvent.Increment),
  };
};
