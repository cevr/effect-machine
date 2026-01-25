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

describe("Internal Transitions", () => {
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

  test("internal=true skips exit/enter effects for same state", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Form({ name: "", count: 0 })),
            on(
              State.Form,
              Event.SetName,
              ({ state, event }) => State.Form({ name: event.name, count: state.count + 1 }),
              { internal: true },
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

        // SetName with internal=true should NOT fire exit/enter
        yield* actor.send(Event.SetName({ name: "Alice" }));
        yield* yieldFibers;

        const state = yield* actor.state.get;
        expect(state._tag).toBe("Form");
        expect((state as State & { _tag: "Form" }).name).toBe("Alice");
        expect(effects).toEqual(["enter:Form"]); // No additional effects

        // Another internal transition
        yield* actor.send(Event.SetName({ name: "Bob" }));
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form"]); // Still no additional effects

        // Non-internal transition should run exit
        yield* actor.send(Event.Submit());
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form", "exit:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("default behavior runs exit/enter for same state tag", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Form({ name: "", count: 0 })),
            // No internal flag - default behavior
            on(State.Form, Event.SetName, ({ state, event }) =>
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

        // Without internal flag, same state tag does NOT run exit/enter (current behavior)
        yield* actor.send(Event.SetName({ name: "Alice" }));
        yield* yieldFibers;

        // Default is to NOT run lifecycle for same tag (unless reenter)
        expect(effects).toEqual(["enter:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
