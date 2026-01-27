import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import { assertPath, Event, Machine, simulate, State } from "../../src/index.js";

/**
 * Keyboard input pattern tests based on bite keyboard.machine.ts
 * Tests: mode switching, value accumulation, clear/backspace behavior
 */
describe("Keyboard Input Pattern", () => {
  type InputMode = "insert" | "append" | "replace";

  type KeyboardState = State<{
    Idle: { value: string; mode: InputMode };
    Typing: { value: string; mode: InputMode };
    Confirming: { value: string };
  }>;
  const KeyboardState = State<KeyboardState>();

  type KeyboardEvent = Event<{
    Focus: {};
    KeyPress: { key: string };
    Backspace: {};
    Clear: {};
    SwitchMode: { mode: InputMode };
    Submit: {};
    Cancel: {};
  }>;
  const KeyboardEvent = Event<KeyboardEvent>();

  const keyboardMachine = Machine.make<KeyboardState, KeyboardEvent>(
    KeyboardState.Idle({ value: "", mode: "insert" }),
  ).pipe(
    // Focus activates keyboard
    Machine.on(KeyboardState.Idle, KeyboardEvent.Focus, ({ state }) =>
      KeyboardState.Typing({ value: state.value, mode: state.mode }),
    ),

    // Typing state handlers
    Machine.from(KeyboardState.Typing).pipe(
      // Key input - different modes (same state, no lifecycle by default)
      Machine.on(KeyboardEvent.KeyPress, ({ state, event }) => {
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
        return KeyboardState.Typing({ value: newValue, mode: state.mode });
      }),

      // Backspace
      Machine.on(KeyboardEvent.Backspace, ({ state }) =>
        KeyboardState.Typing({ value: state.value.slice(0, -1), mode: state.mode }),
      ),

      // Clear all input
      Machine.on(KeyboardEvent.Clear, ({ state }) =>
        KeyboardState.Typing({ value: "", mode: state.mode }),
      ),

      // Mode switching
      Machine.on(KeyboardEvent.SwitchMode, ({ state, event }) =>
        KeyboardState.Typing({ value: state.value, mode: event.mode }),
      ),

      // Submit
      Machine.on(KeyboardEvent.Submit, ({ state }) =>
        KeyboardState.Confirming({ value: state.value }),
      ),

      // Cancel returns to idle with original value preserved
      Machine.on(KeyboardEvent.Cancel, ({ state }) =>
        KeyboardState.Idle({ value: "", mode: state.mode }),
      ),
    ),

    // From confirming
    Machine.on(KeyboardState.Confirming, KeyboardEvent.Cancel, ({ state }) =>
      KeyboardState.Typing({ value: state.value, mode: "insert" }),
    ),
  );

  test("basic value accumulation", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "1" }),
          KeyboardEvent.KeyPress({ key: "2" }),
          KeyboardEvent.KeyPress({ key: "3" }),
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
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "1" }),
          KeyboardEvent.KeyPress({ key: "2" }),
          KeyboardEvent.KeyPress({ key: "3" }),
          KeyboardEvent.Backspace(),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("12");
      }),
    );
  });

  test("multiple backspaces", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "a" }),
          KeyboardEvent.KeyPress({ key: "b" }),
          KeyboardEvent.Backspace(),
          KeyboardEvent.Backspace(),
          KeyboardEvent.Backspace(), // Extra backspace on empty string
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
      }),
    );
  });

  test("clear resets value", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "1" }),
          KeyboardEvent.KeyPress({ key: "2" }),
          KeyboardEvent.KeyPress({ key: "3" }),
          KeyboardEvent.Clear(),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
      }),
    );
  });

  test("mode switching - replace mode", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "a" }),
          KeyboardEvent.KeyPress({ key: "b" }),
          KeyboardEvent.SwitchMode({ mode: "replace" }),
          KeyboardEvent.KeyPress({ key: "X" }), // Should replace entire value
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
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "1" }),
          KeyboardEvent.KeyPress({ key: "0" }),
          KeyboardEvent.KeyPress({ key: "0" }),
          KeyboardEvent.Submit(),
        ],
        ["Idle", "Typing", "Typing", "Typing", "Typing", "Confirming"],
      ),
    );
  });

  test("cancel from typing returns to idle", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(keyboardMachine, [
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "x" }),
          KeyboardEvent.Cancel(),
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
          KeyboardEvent.Focus(),
          KeyboardEvent.KeyPress({ key: "1" }),
          KeyboardEvent.Submit(),
          KeyboardEvent.Cancel(),
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
          KeyboardEvent.Focus(),
          KeyboardEvent.SwitchMode({ mode: "append" }),
          KeyboardEvent.KeyPress({ key: "a" }),
          KeyboardEvent.Clear(),
          KeyboardEvent.KeyPress({ key: "b" }),
        ]);

        expect((result.finalState as KeyboardState & { _tag: "Typing" }).mode).toBe("append");
      }),
    );
  });
});
