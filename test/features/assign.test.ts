// @effect-diagnostics strictEffectProvide:off

import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

describe("Assign and Update Helpers", () => {
  const FormState = State({
    Editing: { name: Schema.String, email: Schema.String },
    Submitted: { name: Schema.String, email: Schema.String },
  });

  const FormEvent = Event({
    SetName: { name: Schema.String },
    SetEmail: { email: Schema.String },
    Submit: {},
  });

  test("assign helper updates partial state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        })
          .on(
            FormState.Editing,
            FormEvent.SetName,
            Machine.assign(({ event }) => ({ name: event.name })),
          )
          .on(
            FormState.Editing,
            FormEvent.SetEmail,
            Machine.assign(({ event }) => ({ email: event.email })),
          )
          .on(FormState.Editing, FormEvent.Submit, ({ state }) => FormState.Submitted(state))
          .final(FormState.Submitted);

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "John" }),
          FormEvent.SetEmail({ email: "john@example.com" }),
          FormEvent.Submit,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("John");
          expect(result.finalState.email).toBe("john@example.com");
        }
      }),
    );
  });

  test("on with assign is same as update shorthand", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        })
          .on(
            FormState.Editing,
            FormEvent.SetName,
            Machine.assign(({ event }) => ({ name: event.name })),
          )
          .on(
            FormState.Editing,
            FormEvent.SetEmail,
            Machine.assign(({ event }) => ({ email: event.email })),
          )
          .on(FormState.Editing, FormEvent.Submit, ({ state }) => FormState.Submitted(state))
          .final(FormState.Submitted);

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "Jane" }),
          FormEvent.SetEmail({ email: "jane@example.com" }),
          FormEvent.Submit,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("Jane");
          expect(result.finalState.email).toBe("jane@example.com");
        }
      }),
    );
  });

  test("on with assign and guard", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        })
          .on(
            FormState.Editing,
            FormEvent.SetName,
            Machine.assign(({ event }) => ({ name: event.name })),
            {
              guard: ({ event }) => event.name.length <= 50,
            },
          )
          .on(FormState.Editing, FormEvent.Submit, ({ state }) => FormState.Submitted(state))
          .final(FormState.Submitted);

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "A".repeat(100) }), // blocked by guard
          FormEvent.Submit,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("");
        }
      }),
    );
  });
});
