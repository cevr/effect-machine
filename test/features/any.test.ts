import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

// ============================================================================
// Test fixtures
// ============================================================================

const EditorState = State({
  Idle: {},
  Typing: { text: Schema.String },
  Submitting: { text: Schema.String },
  Submitted: { text: Schema.String },
  Cancelled: {},
});
type EditorState = typeof EditorState.Type;

const EditorEvent = Event({
  Focus: {},
  KeyPress: { key: Schema.String },
  Backspace: {},
  Submit: {},
  Cancel: {},
  Success: {},
});
type EditorEvent = typeof EditorEvent.Type;

// ============================================================================
// any() tests
// ============================================================================

describe("Machine.any", () => {
  test("matches multiple states with single handler", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Typing({ text: "hello" }),
        }).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled({}),
          ),
        );

        // Cancel from Typing
        const result1 = yield* simulate(machine, [EditorEvent.Cancel({})]);
        expect(result1.finalState._tag).toBe("Cancelled");

        // Cancel from Submitting
        const result2 = yield* simulate(machine, [EditorEvent.Submit({}), EditorEvent.Cancel({})]);
        expect(result2.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Typing({ text: "abc" }),
        }).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled({}),
            // Guard tests state has text field - both Typing and Submitting have it
            { guard: ({ state }) => "text" in state && state.text.length > 0 },
          ),
        );

        const result = yield* simulate(machine, [EditorEvent.Cancel({})]);
        expect(result.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Typing({ text: "" }),
        }).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled({}),
            {
              effect: ({ state }) =>
                Effect.sync(() => {
                  logs.push(`cancelled from: ${state._tag}`);
                }),
            },
          ),
        );

        yield* simulate(machine, [EditorEvent.Cancel({})]);
        expect(logs).toEqual(["cancelled from: Typing"]);

        logs.length = 0;
        yield* simulate(machine, [EditorEvent.Submit({}), EditorEvent.Cancel({})]);
        expect(logs).toEqual(["cancelled from: Submitting"]);
      }),
    );
  });

  test("any() creates separate transitions (3+ states)", async () => {
    const S = State({
      A: {},
      B: {},
      C: {},
      D: {},
      Done: {},
    });

    const E = Event({
      Next: {},
      Finish: {},
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: S,
          event: E,
          initial: S.A({}),
        }).pipe(
          Machine.on(S.A, E.Next, () => S.B({})),
          Machine.on(S.B, E.Next, () => S.C({})),
          Machine.on(S.C, E.Next, () => S.D({})),
          Machine.on(Machine.any(S.A, S.B, S.C, S.D), E.Finish, () => S.Done({})),
        );

        // Finish from A
        const r1 = yield* simulate(machine, [E.Finish({})]);
        expect(r1.finalState._tag).toBe("Done");

        // Finish from B
        const r2 = yield* simulate(machine, [E.Next({}), E.Finish({})]);
        expect(r2.finalState._tag).toBe("Done");

        // Finish from C
        const r3 = yield* simulate(machine, [E.Next({}), E.Next({}), E.Finish({})]);
        expect(r3.finalState._tag).toBe("Done");

        // Finish from D
        const r4 = yield* simulate(machine, [E.Next({}), E.Next({}), E.Next({}), E.Finish({})]);
        expect(r4.finalState._tag).toBe("Done");
      }),
    );
  });
});

// ============================================================================
// Namespace import tests
// ============================================================================

describe("Machine namespace", () => {
  test("full Machine namespace usage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Idle({}),
        }).pipe(
          Machine.from(EditorState.Idle).pipe(
            Machine.on(EditorEvent.Focus, () => EditorState.Typing({ text: "" })),
          ),
          Machine.from(EditorState.Typing).pipe(
            Machine.on(EditorEvent.KeyPress, ({ state, event }) =>
              EditorState.Typing({ text: state.text + event.key }),
            ),
            Machine.on(EditorEvent.Submit, ({ state }) =>
              EditorState.Submitted({ text: state.text }),
            ),
          ),
          Machine.on(Machine.any(EditorState.Idle, EditorState.Typing), EditorEvent.Cancel, () =>
            EditorState.Cancelled({}),
          ),
          Machine.final(EditorState.Submitted),
          Machine.final(EditorState.Cancelled),
        );

        const result = yield* simulate(machine, [
          EditorEvent.Focus({}),
          EditorEvent.KeyPress({ key: "!" }),
          EditorEvent.Submit({}),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("!");
        }
      }),
    );
  });
});
