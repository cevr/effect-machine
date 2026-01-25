import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import { assign, build, final, make, on, simulate, update } from "../../src/index.js";

describe("Assign and Update Helpers", () => {
  type FormState = Data.TaggedEnum<{
    Editing: { name: string; email: string };
    Submitted: { name: string; email: string };
  }>;
  const State = Data.taggedEnum<FormState>();

  type FormEvent = Data.TaggedEnum<{
    SetName: { name: string };
    SetEmail: { email: string };
    Submit: {};
  }>;
  const Event = Data.taggedEnum<FormEvent>();

  test("assign helper updates partial state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<FormState, FormEvent>(State.Editing({ name: "", email: "" })),
            on(
              State.Editing,
              Event.SetName,
              assign(({ event }) => ({ name: event.name })),
            ),
            on(
              State.Editing,
              Event.SetEmail,
              assign(({ event }) => ({ email: event.email })),
            ),
            on(State.Editing, Event.Submit, ({ state }) => State.Submitted(state)),
            final(State.Submitted),
          ),
        );

        const result = yield* simulate(machine, [
          Event.SetName({ name: "John" }),
          Event.SetEmail({ email: "john@example.com" }),
          Event.Submit(),
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
        const machine = build(
          pipe(
            make<FormState, FormEvent>(State.Editing({ name: "", email: "" })),
            update(State.Editing, Event.SetName, ({ event }) => ({ name: event.name })),
            update(State.Editing, Event.SetEmail, ({ event }) => ({ email: event.email })),
            on(State.Editing, Event.Submit, ({ state }) => State.Submitted(state)),
            final(State.Submitted),
          ),
        );

        const result = yield* simulate(machine, [
          Event.SetName({ name: "Jane" }),
          Event.SetEmail({ email: "jane@example.com" }),
          Event.Submit(),
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
        const machine = build(
          pipe(
            make<FormState, FormEvent>(State.Editing({ name: "", email: "" })),
            update(State.Editing, Event.SetName, ({ event }) => ({ name: event.name }), {
              guard: ({ event }) => event.name.length <= 50,
            }),
            on(State.Editing, Event.Submit, ({ state }) => State.Submitted(state)),
            final(State.Submitted),
          ),
        );

        const result = yield* simulate(machine, [
          Event.SetName({ name: "A".repeat(100) }), // blocked by guard
          Event.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.name).toBe("");
        }
      }),
    );
  });
});
