import { Context, Effect, Schema, Stream } from "effect";
import { Event, Machine, State } from "effect-machine";

const Direction = Schema.Literals(["up", "down", "left", "right", "center"]);
type Direction = typeof Direction.Type;

export class InputDevice extends Context.Service<
  InputDevice,
  { readonly presses: Stream.Stream<Direction> }
>()("effect-machine/examples/InputDevice") {}

const KioskState = State({
  Menu: { selected: Schema.Finite },
  Checkout: { selected: Schema.Finite },
});

const KioskEvent = Event({
  Pressed: { direction: Direction },
});

export const kioskMachine = Machine.make({
  state: KioskState,
  event: KioskEvent,
  initial: KioskState.Menu({ selected: 0 }),
})
  .when(
    KioskState.Menu,
    KioskEvent.Pressed,
    ({ event }) => event.direction === "down",
    ({ state }) => KioskState.Menu.with(state, { selected: state.selected + 1 }),
  )
  .when(
    KioskState.Menu,
    KioskEvent.Pressed,
    ({ event }) => event.direction === "center",
    ({ state }) => KioskState.Checkout.with(state),
  )
  .spawn(KioskState.Menu, ({ self }) =>
    Effect.flatMap(InputDevice, (device) =>
      Stream.runForEach(device.presses, (direction) =>
        self.send(KioskEvent.Pressed({ direction })),
      ),
    ),
  )
  .final(KioskState.Checkout, ({ state }) => state.selected);

export const hardwareNavigationProgram = Machine.run(kioskMachine).pipe(
  Effect.provideService(InputDevice, {
    presses: Stream.fromIterable<Direction>(["down", "down", "center"]),
  }),
);
