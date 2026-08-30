// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Context, Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { Event, Machine, State } from "../src/index.js";

class GreetingService extends Context.Service<
  GreetingService,
  { readonly greet: (name: string) => Effect.Effect<string> }
>()("effect-machine/test/services.test/GreetingService") {}

const GreetingLive = GreetingService.of({
  greet: (name) => Effect.succeed(`Hello, ${name}!`),
});

const GreetingState = State({
  Idle: {},
  Loading: { name: Schema.String },
  Running: {},
  Done: { message: Schema.String },
});

const GreetingEvent = Event({
  Start: { name: Schema.String },
  Run: {},
  Loaded: { message: Schema.String },
});

const taskMachine = Machine.make({
  state: GreetingState,
  event: GreetingEvent,
  initial: GreetingState.Idle,
})
  .on(GreetingState.Idle, GreetingEvent.Start, ({ event }) =>
    GreetingState.Loading({ name: event.name }),
  )
  .task(
    GreetingState.Loading,
    ({ state }) =>
      Effect.gen(function* () {
        const greeting = yield* GreetingService;
        return yield* greeting.greet(state.name);
      }),
    { onSuccess: (message) => GreetingEvent.Loaded({ message }) },
  )
  .on(GreetingState.Loading, GreetingEvent.Loaded, ({ event }) =>
    GreetingState.Done({ message: event.message }),
  )
  .final(GreetingState.Done);

const spawnMachine = Machine.make({
  state: GreetingState,
  event: GreetingEvent,
  initial: GreetingState.Idle,
})
  .on(GreetingState.Idle, GreetingEvent.Run, () => GreetingState.Running)
  .spawn(GreetingState.Running, ({ self }) =>
    Effect.gen(function* () {
      const greeting = yield* GreetingService;
      const message = yield* greeting.greet("Grace");
      yield* self.send(GreetingEvent.Loaded({ message }));
    }),
  )
  .on(GreetingState.Running, GreetingEvent.Loaded, ({ event }) =>
    GreetingState.Done({ message: event.message }),
  )
  .final(GreetingState.Done);

const backgroundMachine = Machine.make({
  state: GreetingState,
  event: GreetingEvent,
  initial: GreetingState.Running,
})
  .background(({ self }) =>
    Effect.gen(function* () {
      const greeting = yield* GreetingService;
      const message = yield* greeting.greet("Lin");
      yield* self.send(GreetingEvent.Loaded({ message }));
    }),
  )
  .on(GreetingState.Running, GreetingEvent.Loaded, ({ event }) =>
    GreetingState.Done({ message: event.message }),
  )
  .final(GreetingState.Done);

describe("native Effect services", () => {
  it.scopedLive("uses a service in a task handler", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(taskMachine);
      yield* actor.start;
      yield* actor.send(GreetingEvent.Start({ name: "Ada" }));

      const state = yield* actor.awaitFinal;
      expect(state).toEqual(GreetingState.Done({ message: "Hello, Ada!" }));
    }).pipe(Effect.provideService(GreetingService, GreetingLive)),
  );

  it.scopedLive("uses a service in a state spawn handler", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(spawnMachine);
      yield* actor.start;
      yield* actor.send(GreetingEvent.Run);

      const state = yield* actor.awaitFinal;
      expect(state).toEqual(GreetingState.Done({ message: "Hello, Grace!" }));
    }).pipe(Effect.provideService(GreetingService, GreetingLive)),
  );

  it.scopedLive("uses a service in a background handler", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(backgroundMachine);
      yield* actor.start;

      const state = yield* actor.awaitFinal;
      expect(state).toEqual(GreetingState.Done({ message: "Hello, Lin!" }));
    }).pipe(Effect.provideService(GreetingService, GreetingLive)),
  );

  it.scopedLive("keeps a service after the actor allocation effect ends", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(spawnMachine).pipe(
        Effect.provideService(GreetingService, GreetingLive),
      );

      yield* actor.start;
      yield* actor.send(GreetingEvent.Run);

      const state = yield* actor.awaitFinal;
      expect(state).toEqual(GreetingState.Done({ message: "Hello, Grace!" }));
    }),
  );
});
