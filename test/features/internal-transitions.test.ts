// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

describe("Same-state Transitions", () => {
  type FormState = State<{
    Form: { name: string; count: number };
    Submitted: {};
  }>;
  const FormState = State<FormState>();

  type FormEvent = Event<{
    SetName: { name: string };
    Submit: {};
  }>;
  const FormEvent = Event<FormEvent>();

  test("default: same state tag skips exit/enter effects", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<FormState, FormEvent>(FormState.Form({ name: "", count: 0 })).pipe(
            Machine.on(FormState.Form, FormEvent.SetName, ({ state, event }) =>
              FormState.Form({ name: event.name, count: state.count + 1 }),
            ),
            Machine.on(FormState.Form, FormEvent.Submit, () => FormState.Submitted()),
            Machine.onEnter(FormState.Form, () => Effect.sync(() => effects.push("enter:Form"))),
            Machine.onExit(FormState.Form, () => Effect.sync(() => effects.push("exit:Form"))),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("form", machine);

        // Initial enter should fire
        expect(effects).toEqual(["enter:Form"]);

        // Same state tag - no exit/enter
        yield* actor.send(FormEvent.SetName({ name: "Alice" }));
        yield* yieldFibers;

        const state = yield* actor.state.get;
        expect(state._tag).toBe("Form");
        expect((state as FormState & { _tag: "Form" }).name).toBe("Alice");
        expect(effects).toEqual(["enter:Form"]);

        // Another same-state transition
        yield* actor.send(FormEvent.SetName({ name: "Bob" }));
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form"]);

        // Different state tag - runs exit
        yield* actor.send(FormEvent.Submit());
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form", "exit:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });

  test("on.force runs exit/enter for same state tag", async () => {
    const effects: string[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<FormState, FormEvent>(FormState.Form({ name: "", count: 0 })).pipe(
            Machine.on.force(FormState.Form, FormEvent.SetName, ({ state, event }) =>
              FormState.Form({ name: event.name, count: state.count + 1 }),
            ),
            Machine.onEnter(FormState.Form, () => Effect.sync(() => effects.push("enter:Form"))),
            Machine.onExit(FormState.Form, () => Effect.sync(() => effects.push("exit:Form"))),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("form", machine);

        // Initial enter
        expect(effects).toEqual(["enter:Form"]);

        // on.force runs exit/enter even for same state tag
        yield* actor.send(FormEvent.SetName({ name: "Alice" }));
        yield* yieldFibers;

        expect(effects).toEqual(["enter:Form", "exit:Form", "enter:Form"]);
      }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
    );
  });
});
