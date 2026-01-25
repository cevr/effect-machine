import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import { assertPath, build, make, on, simulate } from "../../src/index.js";

/**
 * Keyboard input pattern tests based on bite keyboard.machine.ts
 * Tests: mode switching, value accumulation, clear/backspace behavior
 */
describe("Keyboard Input Pattern", () => {
  type InputMode = "insert" | "append" | "replace";

  type KeyboardState = Data.TaggedEnum<{
    Idle: { value: string; mode: InputMode };
    Typing: { value: string; mode: InputMode };
    Confirming: { value: string };
  }>;
  const State = Data.taggedEnum<KeyboardState>();

  type KeyboardEvent = Data.TaggedEnum<{
    Focus: {};
    KeyPress: { key: string };
    Backspace: {};
    Clear: {};
    SwitchMode: { mode: InputMode };
    Submit: {};
    Cancel: {};
  }>;
  const Event = Data.taggedEnum<KeyboardEvent>();

  const keyboardMachine = build(
    pipe(
      make<KeyboardState, KeyboardEvent>(State.Idle({ value: "", mode: "insert" })),

      // Focus activates keyboard
      on(State.Idle, Event.Focus, ({ state }) =>
        State.Typing({ value: state.value, mode: state.mode }),
      ),

      // Key input - different modes
      on(
        State.Typing,
        Event.KeyPress,
        ({ state, event }) => {
          let newValue: string;
          switch (state.mode) {
            case "insert":
              newValue = state.value + event.key;
              break;
            case "append":
              newValue = state.value + event.key;
              break;
            case "replace":
              newValue = event.key;
              break;
          }
          return State.Typing({ value: newValue, mode: state.mode });
        },
        { internal: true }, // Stay in typing, don't re-trigger effects
      ),

      // Backspace
      on(
        State.Typing,
        Event.Backspace,
        ({ state }) => State.Typing({ value: state.value.slice(0, -1), mode: state.mode }),
        { internal: true },
      ),

      // Clear all input
      on(State.Typing, Event.Clear, ({ state }) => State.Typing({ value: "", mode: state.mode }), {
        internal: true,
      }),

      // Mode switching
      on(
        State.Typing,
        Event.SwitchMode,
        ({ state, event }) => State.Typing({ value: state.value, mode: event.mode }),
        { internal: true },
      ),

      // Submit
      on(State.Typing, Event.Submit, ({ state }) => State.Confirming({ value: state.value })),

      // Cancel returns to idle with original value preserved
      on(State.Typing, Event.Cancel, ({ state }) => State.Idle({ value: "", mode: state.mode })),

      // From confirming
      on(State.Confirming, Event.Cancel, ({ state }) =>
        State.Typing({ value: state.value, mode: "insert" }),
      ),
    ),
  );

  test("basic value accumulation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "1" }),
          Event.KeyPress({ key: "2" }),
          Event.KeyPress({ key: "3" }),
        ]);

        expect(result.finalState._tag).toBe("Typing");
        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("123");
      }),
    );
  });

  test("backspace removes last character", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "1" }),
          Event.KeyPress({ key: "2" }),
          Event.KeyPress({ key: "3" }),
          Event.Backspace(),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("12");
      }),
    );
  });

  test("multiple backspaces", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "a" }),
          Event.KeyPress({ key: "b" }),
          Event.Backspace(),
          Event.Backspace(),
          Event.Backspace(), // Extra backspace on empty string
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
      }),
    );
  });

  test("clear resets value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "1" }),
          Event.KeyPress({ key: "2" }),
          Event.KeyPress({ key: "3" }),
          Event.Clear(),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
      }),
    );
  });

  test("mode switching - replace mode", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "a" }),
          Event.KeyPress({ key: "b" }),
          Event.SwitchMode({ mode: "replace" }),
          Event.KeyPress({ key: "X" }), // Should replace entire value
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("X");
        expect((result.finalState as KeyboardState & { _tag: "Typing" }).mode).toBe("replace");
      }),
    );
  });

  test("submit flow", async () => {
    await Effect.runPromise(
      assertPath(
        keyboardMachine,
        [
          Event.Focus(),
          Event.KeyPress({ key: "1" }),
          Event.KeyPress({ key: "0" }),
          Event.KeyPress({ key: "0" }),
          Event.Submit(),
        ],
        ["Idle", "Typing", "Typing", "Typing", "Typing", "Confirming"],
      ),
    );
  });

  test("cancel from typing returns to idle", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "x" }),
          Event.Cancel(),
        ]);

        expect(result.finalState._tag).toBe("Idle");
        // Value is cleared on cancel
        expect((result.finalState as KeyboardState & { _tag: "Idle" }).value).toBe("");
      }),
    );
  });

  test("cancel from confirming returns to typing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.KeyPress({ key: "1" }),
          Event.Submit(),
          Event.Cancel(),
        ]);

        expect(result.finalState._tag).toBe("Typing");
        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("1");
      }),
    );
  });

  test("preserves mode through operations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          Event.Focus(),
          Event.SwitchMode({ mode: "append" }),
          Event.KeyPress({ key: "a" }),
          Event.Clear(),
          Event.KeyPress({ key: "b" }),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).mode).toBe("append");
      }),
    );
  });
});
