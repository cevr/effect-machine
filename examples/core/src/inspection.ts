import { Effect, Schema } from "effect";
import { collectingInspector, Event, Machine, State, type InspectionEvent } from "effect-machine";

const AccessState = State({
  Locked: { attempts: Schema.Finite },
  Open: {},
});
type AccessState = typeof AccessState.Type;

const AccessEvent = Event({
  EnterCode: { code: Schema.String },
});
type AccessEvent = typeof AccessEvent.Type;

const accessMachine = Machine.make({
  state: AccessState,
  event: AccessEvent,
  initial: AccessState.Locked({ attempts: 0 }),
})
  .when(
    AccessState.Locked,
    AccessEvent.EnterCode,
    function correctCode({ event }) {
      return event.code === "1234";
    },
    function unlock() {
      return AccessState.Open;
    },
  )
  .on(AccessState.Locked, AccessEvent.EnterCode, function recordFailedAttempt({ state }) {
    return AccessState.Locked({ attempts: state.attempts + 1 });
  })
  .final(AccessState.Open);

export const inspectionProgram = Effect.gen(function* () {
  const events: Array<InspectionEvent<AccessState, AccessEvent>> = [];
  const actor = yield* Machine.spawn(accessMachine, {
    id: "access",
    inspect: collectingInspector(events),
  });
  yield* actor.start;
  yield* actor.send(AccessEvent.EnterCode({ code: "0000" }));
  yield* actor.send(AccessEvent.EnterCode({ code: "1234" }));
  yield* actor.awaitFinal;
  return events;
});
