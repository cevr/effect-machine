// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  build,
  make,
  on,
  onEnter,
  onExit,
  yieldFibers,
} from "../../src/index.js";

describe("Same-state Transitions", () => {
  type State = Data.TaggedEnum<{
    Form: { name: string; count: number };
    Submitted: {};
  }>;
  const State = Data.taggedEnum<State>();

  type Event = Data.TaggedEnum<{
    SetName: { name: string };
    Submit: {};
  }>;
  const Event = Data.taggedEnum<Event>();

  test("default: same state tag skips exit/enter effects", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Form({ name: "", count: 0 })),
            on(State.Form, Event.SetName, ({ state, event }) =>
              State.Form({ name: event.name, count: state.count + 1 }),
            ),
            on(State.Form, Event.Submit, () => State.Submitted()),
            onEnter(State.Form, () => Effect.sync(() => effects.push("enter:Form"))),
            onExit(State.Form, () => Effect.sync(() => effects.push("exit:Form"))),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("form", machine);

        // Initial enter should fire
        expect(effects).toEqual(["enter:Form"]);

        // Same state tag - no exit/enter
        yield* actor.send(Event.SetName({ name: "Alice" }));
        yield* yieldFibers;

        const state = yield* actor.state.get;
        expect(state._tag).toBe("Form");
        expect((state as State & { _tag: "Form" }).name).toBe("Alice");
        expect(effects).toEqual(["enter:Form"]);

        // Another same-state transition
        yield* actor.send(Event.SetName({ name: "Bob" }));
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form"]);

        // Different state tag - runs exit
        yield* actor.send(Event.Submit());
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form", "exit:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("on.force runs exit/enter for same state tag", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Form({ name: "", count: 0 })),
            on.force(State.Form, Event.SetName, ({ state, event }) =>
              State.Form({ name: event.name, count: state.count + 1 }),
            ),
            onEnter(State.Form, () => Effect.sync(() => effects.push("enter:Form"))),
            onExit(State.Form, () => Effect.sync(() => effects.push("exit:Form"))),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("form", machine);

        // Initial enter
        expect(effects).toEqual(["enter:Form"]);

        // on.force runs exit/enter even for same state tag
        yield* actor.send(Event.SetName({ name: "Alice" }));
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form", "exit:Form", "enter:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
