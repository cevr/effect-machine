import { Effect, Schema } from "effect";
import { Event, Machine, State } from "effect-machine";

export const CounterState = State({
  Counting: { count: Schema.Finite, limit: Schema.Finite },
  AtLimit: { count: Schema.Finite, limit: Schema.Finite },
  Done: { count: Schema.Finite },
});

export const CounterEvent = Event({
  Increment: {},
  Finish: {},
});

export const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: (input: { readonly count: number; readonly limit: number }) =>
    CounterState.Counting(input),
})
  .when(
    CounterState.Counting,
    CounterEvent.Increment,
    ({ state }) => state.count < state.limit,
    ({ state }) => CounterState.Counting.with(state, { count: state.count + 1 }),
  )
  .on(CounterState.Counting, CounterEvent.Increment, ({ state }) =>
    CounterState.AtLimit.with(state),
  )
  .on([CounterState.Counting, CounterState.AtLimit], CounterEvent.Finish, ({ state }) =>
    CounterState.Done.with(state),
  )
  .final(CounterState.Done, ({ state }) => state.count);

export const basicProgram = Effect.scoped(
  Machine.scoped(
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(counterMachine, { input: { count: 0, limit: 2 } });
      yield* actor.start;
      yield* actor.send(CounterEvent.Increment);
      yield* actor.send(CounterEvent.Increment);
      yield* actor.send(CounterEvent.Increment);
      yield* actor.send(CounterEvent.Finish);
      return yield* actor.awaitOutput;
    }),
  ),
);
