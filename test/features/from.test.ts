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
// from() tests
// ============================================================================

describe("Machine.from", () => {
  test("scopes multiple transitions to a single state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Idle,
        }).pipe(
          Machine.on(EditorState.Idle, EditorEvent.Focus, () => EditorState.Typing({ text: "" })),
          Machine.from(EditorState.Typing).pipe(
            Machine.on(EditorEvent.KeyPress, ({ state, event }) =>
              EditorState.Typing({ text: state.text + event.key }),
            ),
            Machine.on(EditorEvent.Backspace, ({ state }) =>
              EditorState.Typing({ text: state.text.slice(0, -1) }),
            ),
            Machine.on(EditorEvent.Submit, ({ state }) =>
              EditorState.Submitted({ text: state.text }),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          EditorEvent.Focus,
          EditorEvent.KeyPress({ key: "h" }),
          EditorEvent.KeyPress({ key: "i" }),
          EditorEvent.Submit,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("hi");
        }
      }),
    );
  });

  test("from().pipe() transitions work with guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Typing({ text: "" }),
        }).pipe(
          Machine.from(EditorState.Typing).pipe(
            Machine.on(
              EditorEvent.KeyPress,
              ({ state, event }) => EditorState.Typing({ text: state.text + event.key }),
              { guard: ({ state }) => state.text.length < 3 },
            ),
            Machine.on(EditorEvent.Submit, ({ state }) =>
              EditorState.Submitted({ text: state.text }),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          EditorEvent.KeyPress({ key: "a" }),
          EditorEvent.KeyPress({ key: "b" }),
          EditorEvent.KeyPress({ key: "c" }),
          EditorEvent.KeyPress({ key: "d" }), // blocked by guard
          EditorEvent.Submit,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("abc");
        }
      }),
    );
  });

  test("from().pipe() transitions work with effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Typing({ text: "" }),
        }).pipe(
          Machine.from(EditorState.Typing).pipe(
            Machine.on(
              EditorEvent.KeyPress,
              ({ state, event }) => EditorState.Typing({ text: state.text + event.key }),
              {
                effect: ({ event }) =>
                  Effect.sync(() => {
                    logs.push(`key: ${event.key}`);
                  }),
              },
            ),
            Machine.on(EditorEvent.Submit, ({ state }) =>
              EditorState.Submitted({ text: state.text }),
            ),
          ),
        );

        yield* simulate(machine, [
          EditorEvent.KeyPress({ key: "h" }),
          EditorEvent.KeyPress({ key: "i" }),
          EditorEvent.Submit,
        ]);

        expect(logs).toEqual(["key: h", "key: i"]);
      }),
    );
  });

  test("multiple from() scopes can be combined", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: EditorState,
          event: EditorEvent,
          initial: EditorState.Idle,
        }).pipe(
          Machine.from(EditorState.Idle).pipe(
            Machine.on(EditorEvent.Focus, () => EditorState.Typing({ text: "" })),
          ),
          Machine.from(EditorState.Typing).pipe(
            Machine.on(EditorEvent.KeyPress, ({ state, event }) =>
              EditorState.Typing({ text: state.text + event.key }),
            ),
            Machine.on(EditorEvent.Submit, ({ state }) =>
              EditorState.Submitting({ text: state.text }),
            ),
          ),
          Machine.from(EditorState.Submitting).pipe(
            Machine.on(EditorEvent.Success, ({ state }) =>
              EditorState.Submitted({ text: state.text }),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          EditorEvent.Focus,
          EditorEvent.KeyPress({ key: "x" }),
          EditorEvent.Submit,
          EditorEvent.Success,
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("x");
        }
      }),
    );
  });
});
