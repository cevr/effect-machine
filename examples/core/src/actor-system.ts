import { Effect, Option } from "effect";
import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "effect-machine";

const MenuState = State({ Browsing: {}, Closed: {} });
const MenuEvent = Event({ Close: {} });
const menuMachine = Machine.make({
  state: MenuState,
  event: MenuEvent,
  initial: MenuState.Browsing,
})
  .on(MenuState.Browsing, MenuEvent.Close, () => MenuState.Closed)
  .final(MenuState.Closed);

const SessionState = State({ Cover: {}, Menu: {}, Done: {} });
const SessionEvent = Event({ Start: {}, Exit: {} });

export const sessionMachine = Machine.make({
  state: SessionState,
  event: SessionEvent,
  initial: SessionState.Cover,
})
  .on(SessionState.Cover, SessionEvent.Start, () => SessionState.Menu)
  .on(SessionState.Menu, SessionEvent.Exit, () => SessionState.Done)
  .spawn(SessionState.Menu, ({ self }) =>
    self.spawn("menu", menuMachine).pipe(Effect.asVoid, Effect.orDie),
  )
  .final(SessionState.Done);

export const actorSystemProgram = Effect.gen(function* () {
  const system = yield* ActorSystemService;
  const session = yield* system.spawn("session", sessionMachine);
  yield* session.send(SessionEvent.Start);
  yield* session.waitFor(SessionState.Menu);
  yield* Effect.yieldNow;

  const menu = yield* system.get("menu");
  if (Option.isNone(menu)) return false;

  yield* session.send(SessionEvent.Exit);
  yield* session.awaitFinal;
  return menu.value.sync.matches("Browsing");
}).pipe(Effect.scoped, Effect.provide(ActorSystemDefault));
