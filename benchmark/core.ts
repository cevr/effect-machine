import { Effect, Schema } from "effect";

import { Event, Machine, State, simulate } from "../src/index.js";

const CounterState = State({
  Active: { count: Schema.Finite },
});

const CounterEvent = Event({
  Increment: {},
  Barrier: {},
});

const machine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Active({ count: 0 }),
})
  .on(CounterState.Active, CounterEvent.Increment, ({ state }) =>
    CounterState.Active({ count: state.count + 1 }),
  )
  .on(CounterState.Active, CounterEvent.Barrier, ({ state }) => state);

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const measure = async (
  name: string,
  operations: number,
  run: () => Promise<number>,
): Promise<void> => {
  for (let index = 0; index < 5; index++) await run();
  const samples: number[] = [];
  for (let index = 0; index < 9; index++) {
    const started = Bun.nanoseconds();
    const result = await run();
    const elapsed = Bun.nanoseconds() - started;
    if (result !== operations) throw new Error(`${name}: expected ${operations}, got ${result}`);
    samples.push(elapsed);
  }
  const elapsed = median(samples);
  const operationsPerSecond = operations / (elapsed / 1_000_000_000);
  console.log(
    JSON.stringify({
      name,
      operations,
      medianMs: Number((elapsed / 1_000_000).toFixed(3)),
      operationsPerSecond: Math.round(operationsPerSecond),
      samplesMs: samples.map((sample) => Number((sample / 1_000_000).toFixed(3))),
    }),
  );
};

const simulateOperations = 250_000;
const events = Array.from({ length: simulateOperations }, () => CounterEvent.Increment);

await measure("simulate", simulateOperations, async () => {
  const result = await Effect.runPromise(simulate(machine, events));
  return result.finalState.count;
});

const actorSendOperations = 50_000;
await measure("actor-send", actorSendOperations, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        for (let index = 0; index < actorSendOperations; index++) {
          yield* actor.send(CounterEvent.Increment);
        }
        yield* actor.call(CounterEvent.Barrier);
        const state = yield* actor.snapshot;
        yield* actor.stop;
        return state.count;
      }),
    ),
  ),
);

const actorCallOperations = 10_000;
await measure("actor-call", actorCallOperations, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        for (let index = 0; index < actorCallOperations; index++) {
          yield* actor.call(CounterEvent.Increment);
        }
        const state = yield* actor.snapshot;
        yield* actor.stop;
        return state.count;
      }),
    ),
  ),
);

// Each listener counts the states it gets; the result is the last count the first one saw.
const notifyOperations = 50_000;
for (const listenerCount of [1, 8]) {
  await measure(`actor-send-${listenerCount}-subscribers`, notifyOperations, () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* Machine.spawn(machine);
          yield* actor.start;
          let lastCount = 0;
          const unsubscribes = Array.from({ length: listenerCount }, (_, listener) =>
            actor.subscribe((state) => {
              if (listener === 0) lastCount = state.count;
            }),
          );
          for (let index = 0; index < notifyOperations; index++) {
            yield* actor.send(CounterEvent.Increment);
          }
          yield* actor.call(CounterEvent.Barrier);
          for (const unsubscribe of unsubscribes) unsubscribe();
          yield* actor.stop;
          return lastCount;
        }),
      ),
    ),
  );
}

const subscribeOperations = 10_000;
await measure("subscribe-unsubscribe", subscribeOperations, () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        let pairs = 0;
        for (let index = 0; index < subscribeOperations; index++) {
          actor.subscribe(() => {
            pairs -= 1;
          })();
          pairs += 1;
        }
        yield* actor.stop;
        return pairs;
      }),
    ),
  ),
);
