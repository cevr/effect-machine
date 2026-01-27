// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";

import { ActorSystemDefault, ActorSystemService, Event, Machine, State } from "../../src/index.js";
import { describe, expect, it, yieldFibers } from "../utils/effect-test.js";

describe("Same-state Transitions", () => {
  const FormState = State({
    Form: { name: Schema.String, count: Schema.Number },
    Submitted: {},
  });
  type FormState = typeof FormState.Type;

  const FormEvent = Event({
    SetName: { name: Schema.String },
    Submit: {},
  });
  type FormEvent = typeof FormEvent.Type;

  it.scopedLive("default: same state tag skips exit/enter effects", () =>
    Effect.gen(function* () {
      const effects: string[] = [];

      const baseMachine = Machine.make({
        state: FormState,
        event: FormEvent,
        initial: FormState.Form({ name: "", count: 0 }),
      }).pipe(
        Machine.on(FormState.Form, FormEvent.SetName, ({ state, event }) =>
          FormState.Form({ name: event.name, count: state.count + 1 }),
        ),
        Machine.on(FormState.Form, FormEvent.Submit, () => FormState.Submitted),
        Machine.onEnter(FormState.Form, "enterForm"),
        Machine.onExit(FormState.Form, "exitForm"),
      );

      const machine = Machine.provide(baseMachine, {
        enterForm: () => Effect.sync(() => effects.push("enter:Form")),
        exitForm: () => Effect.sync(() => effects.push("exit:Form")),
      });

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
      yield* actor.send(FormEvent.Submit);
      yield* yieldFibers;

      expect(effects).toEqual(["enter:Form", "exit:Form"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("on.force runs exit/enter for same state tag", () =>
    Effect.gen(function* () {
      const effects: string[] = [];

      const baseMachine = Machine.make({
        state: FormState,
        event: FormEvent,
        initial: FormState.Form({ name: "", count: 0 }),
      }).pipe(
        Machine.on.force(FormState.Form, FormEvent.SetName, ({ state, event }) =>
          FormState.Form({ name: event.name, count: state.count + 1 }),
        ),
        Machine.onEnter(FormState.Form, "enterForm"),
        Machine.onExit(FormState.Form, "exitForm"),
      );

      const machine = Machine.provide(baseMachine, {
        enterForm: () => Effect.sync(() => effects.push("enter:Form")),
        exitForm: () => Effect.sync(() => effects.push("exit:Form")),
      });

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("form", machine);

      // Initial enter
      expect(effects).toEqual(["enter:Form"]);

      // on.force runs exit/enter even for same state tag
      yield* actor.send(FormEvent.SetName({ name: "Alice" }));
      yield* yieldFibers;

      expect(effects).toEqual(["enter:Form", "exit:Form", "enter:Form"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
