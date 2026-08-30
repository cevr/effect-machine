import { Effect, Schema } from "effect";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { Event, Machine, State } from "effect-machine";
import * as ActorAtom from "effect-machine/atom";

const ProfileState = State({
  Editing: { name: Schema.String, visits: Schema.Finite },
});

const ProfileEvent = Event({
  Rename: { name: Schema.String },
  Visit: {},
});

const profileMachine = Machine.make({
  state: ProfileState,
  event: ProfileEvent,
  initial: ProfileState.Editing({ name: "Ada", visits: 0 }),
})
  .on(ProfileState.Editing, ProfileEvent.Rename, ({ state, event }) =>
    ProfileState.Editing.with(state, { name: event.name }),
  )
  .on(ProfileState.Editing, ProfileEvent.Visit, ({ state }) =>
    ProfileState.Editing.with(state, { visits: state.visits + 1 }),
  );

export const atomProgram = Effect.gen(function* () {
  const actor = yield* Machine.spawn(profileMachine);
  yield* actor.start;

  const registry = AtomRegistry.make();
  const stateAtom = ActorAtom.make(actor);
  const visitsAtom = ActorAtom.select(stateAtom, (state) => state.visits);
  const visits: Array<number> = [];
  const unsubscribe = registry.subscribe(visitsAtom, (value) => visits.push(value), {
    immediate: true,
  });

  registry.set(visitsAtom, ProfileEvent.Rename({ name: "Grace" }));
  yield* actor.waitFor((state) => state.name === "Grace");
  registry.set(visitsAtom, ProfileEvent.Visit);
  yield* actor.waitFor((state) => state.visits === 1);
  yield* Effect.yieldNow;

  unsubscribe();
  registry.dispose();
  yield* actor.stop;
  return visits;
});
