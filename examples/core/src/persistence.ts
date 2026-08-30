import { Effect, Option, Ref, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

const DraftState = State({
  Editing: { text: Schema.String },
  Saved: { text: Schema.String },
});
type DraftState = typeof DraftState.Type;

const DraftEvent = Event({
  Change: { text: Schema.String },
  Save: {},
});

const draftMachine = Machine.make({
  state: DraftState,
  event: DraftEvent,
  initial: DraftState.Editing({ text: "" }),
})
  .on(DraftState.Editing, DraftEvent.Change, ({ event }) =>
    DraftState.Editing({ text: event.text }),
  )
  .on(DraftState.Editing, DraftEvent.Save, ({ state }) => DraftState.Saved.with(state))
  .final(DraftState.Saved);

export const persistenceProgram = Effect.gen(function* () {
  const stored = yield* Ref.make<Option.Option<DraftState>>(Option.none());
  const lifecycle = {
    recovery: {
      resolve: () => Ref.get(stored),
    },
    durability: {
      save: (commit: { readonly nextState: DraftState }) =>
        Ref.set(stored, Option.some(commit.nextState)),
    },
  };

  const first = yield* Machine.spawn(draftMachine, { id: "draft", lifecycle });
  yield* first.start;
  yield* first.call(DraftEvent.Change({ text: "Retained draft" }));
  yield* first.stop;

  const recovered = yield* Machine.spawn(draftMachine, { id: "draft", lifecycle });
  yield* recovered.start;
  const state = yield* recovered.snapshot;
  yield* recovered.stop;
  return state;
});
