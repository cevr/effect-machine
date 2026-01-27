import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

describe("Assign and Update Helpers", () => {
  const FormState = State({
    Editing: { name: Schema.String, email: Schema.String },
    Submitted: { name: Schema.String, email: Schema.String },
  });
  type FormState = typeof FormState.Type;

  const FormEvent = Event({
    SetName: { name: Schema.String },
    SetEmail: { email: Schema.String },
    Submit: {},
  });
  type FormEvent = typeof FormEvent.Type;

  test("assign helper updates partial state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        }).pipe(
          Machine.on(
            FormState.Editing,
            FormEvent.SetName,
            Machine.assign(({ event }) => ({ name: event.name })),
          ),
          Machine.on(
            FormState.Editing,
            FormEvent.SetEmail,
            Machine.assign(({ event }) => ({ email: event.email })),
          ),
          Machine.on(FormState.Editing, FormEvent.Submit, ({ state }) =>
            FormState.Submitted(state),
          ),
          Machine.final(FormState.Submitted),
        );

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "John" }),
          FormEvent.SetEmail({ email: "john@example.com" }),
          FormEvent.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("John");
          expect(result.finalState.email).toBe("john@example.com");
        }
      }),
    );
  });

  test("update combinator is shorthand for on + assign", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        }).pipe(
          Machine.update(FormState.Editing, FormEvent.SetName, ({ event }) => ({
            name: event.name,
          })),
          Machine.update(FormState.Editing, FormEvent.SetEmail, ({ event }) => ({
            email: event.email,
          })),
          Machine.on(FormState.Editing, FormEvent.Submit, ({ state }) =>
            FormState.Submitted(state),
          ),
          Machine.final(FormState.Submitted),
        );

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "Jane" }),
          FormEvent.SetEmail({ email: "jane@example.com" }),
          FormEvent.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("Jane");
          expect(result.finalState.email).toBe("jane@example.com");
        }
      }),
    );
  });

  test("update with guard", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: FormState,
          event: FormEvent,
          initial: FormState.Editing({ name: "", email: "" }),
        }).pipe(
          Machine.update(
            FormState.Editing,
            FormEvent.SetName,
            ({ event }) => ({ name: event.name }),
            {
              guard: ({ event }) => event.name.length <= 50,
            },
          ),
          Machine.on(FormState.Editing, FormEvent.Submit, ({ state }) =>
            FormState.Submitted(state),
          ),
          Machine.final(FormState.Submitted),
        );

        const result = yield* simulate(machine, [
          FormEvent.SetName({ name: "A".repeat(100) }), // blocked by guard
          FormEvent.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("");
        }
      }),
    );
  });
});
