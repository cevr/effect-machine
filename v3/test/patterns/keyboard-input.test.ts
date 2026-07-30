import { Effect, Schema } from "effect";

import { assertPath, Event, Machine, simulate, State } from "../../src/index.js";
import { describe, expect, it } from "effect-bun-test/v3";

/**
 * Keyboard input pattern tests based on bite keyboard.machine.ts
 * Tests: mode switching, value accumulation, clear/backspace behavior
 */
describe("Keyboard Input Pattern", () => {
  type InputMode = "insert" | "append" | "replace";
  const InputMode = Schema.Literal("insert", "append", "replace");

  const KeyboardState = State({
    Idle: { value: Schema.String, mode: InputMode },
    Typing: { value: Schema.String, mode: InputMode },
    Confirming: { value: Schema.String },
  });
  type KeyboardState = typeof KeyboardState.Type;

  const KeyboardEvent = Event({
    Focus: {},
    KeyPress: { key: Schema.String },
    Backspace: {},
    Clear: {},
    SwitchMode: { mode: InputMode },
    Submit: {},
    Cancel: {},
  });
  type KeyboardEvent = typeof KeyboardEvent.Type;

  const keyboardMachine = Machine.make({
    state: KeyboardState,
    event: KeyboardEvent,
    initial: KeyboardState.Idle({ value: "", mode: "insert" }),
  })
    // Focus activates keyboard
    .on(KeyboardState.Idle, KeyboardEvent.Focus, ({ state }) =>
      KeyboardState.Typing({ value: state.value, mode: state.mode }),
    )
    // Typing state handlers
    // Key input - different modes (same state, no lifecycle by default)
    .on(KeyboardState.Typing, KeyboardEvent.KeyPress, ({ state, event }) => {
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
    })
    // Backspace
    .on(KeyboardState.Typing, KeyboardEvent.Backspace, ({ state }) =>
      KeyboardState.Typing({ value: state.value.slice(0, -1), mode: state.mode }),
    )
    // Clear all input
    .on(KeyboardState.Typing, KeyboardEvent.Clear, ({ state }) =>
      KeyboardState.Typing({ value: "", mode: state.mode }),
    )
    // Mode switching
    .on(KeyboardState.Typing, KeyboardEvent.SwitchMode, ({ state, event }) =>
      KeyboardState.Typing({ value: state.value, mode: event.mode }),
    )
    // Submit
    .on(KeyboardState.Typing, KeyboardEvent.Submit, ({ state }) =>
      KeyboardState.Confirming({ value: state.value }),
    )
    // Cancel
    .on(KeyboardState.Typing, KeyboardEvent.Cancel, () =>
      KeyboardState.Idle({ value: "", mode: "insert" }),
    )
    // Confirming state - cancel returns to typing
    .on(KeyboardState.Confirming, KeyboardEvent.Cancel, ({ state }) =>
      KeyboardState.Typing({ value: state.value, mode: "insert" }),
    );

  it.scopedLive("basic value accumulation", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "1" }),
        KeyboardEvent.KeyPress({ key: "2" }),
        KeyboardEvent.KeyPress({ key: "3" }),
      ]);

      expect(result.finalState._tag).toBe("Typing");
      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("123");
    }),
  );

  it.scopedLive("backspace removes last character", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "1" }),
        KeyboardEvent.KeyPress({ key: "2" }),
        KeyboardEvent.KeyPress({ key: "3" }),
        KeyboardEvent.Backspace,
      ]);

      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("12");
    }),
  );

  it.scopedLive("multiple backspaces", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "a" }),
        KeyboardEvent.KeyPress({ key: "b" }),
        KeyboardEvent.Backspace,
        KeyboardEvent.Backspace,
        KeyboardEvent.Backspace, // Extra backspace on empty string
      ]);

      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
    }),
  );

  it.scopedLive("clear resets value", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "1" }),
        KeyboardEvent.KeyPress({ key: "2" }),
        KeyboardEvent.KeyPress({ key: "3" }),
        KeyboardEvent.Clear,
      ]);

      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("");
    }),
  );

  it.scopedLive("mode switching - replace mode", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "a" }),
        KeyboardEvent.KeyPress({ key: "b" }),
        KeyboardEvent.SwitchMode({ mode: "replace" }),
        KeyboardEvent.KeyPress({ key: "X" }), // Should replace entire value
      ]);

      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("X");
      expect((result.finalState as KeyboardState & { _tag: "Typing" }).mode).toBe("replace");
    }),
  );

  it.scopedLive("submit flow", () =>
    assertPath(
      keyboardMachine,
      [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "1" }),
        KeyboardEvent.KeyPress({ key: "0" }),
        KeyboardEvent.KeyPress({ key: "0" }),
        KeyboardEvent.Submit,
      ],
      ["Idle", "Typing", "Typing", "Typing", "Typing", "Confirming"],
    ).pipe(Effect.asVoid),
  );

  it.scopedLive("cancel from typing returns to idle", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "x" }),
        KeyboardEvent.Cancel,
      ]);

      expect(result.finalState._tag).toBe("Idle");
      // Value is cleared on cancel
      expect((result.finalState as KeyboardState & { _tag: "Idle" }).value).toBe("");
    }),
  );

  it.scopedLive("cancel from confirming returns to typing", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.KeyPress({ key: "1" }),
        KeyboardEvent.Submit,
        KeyboardEvent.Cancel,
      ]);

      expect(result.finalState._tag).toBe("Typing");
      expect((result.finalState as KeyboardState & { _tag: "Typing" }).value).toBe("1");
    }),
  );

  it.scopedLive("preserves mode through operations", () =>
    Effect.gen(function* () {
      const result = yield* simulate(keyboardMachine, [
        KeyboardEvent.Focus,
        KeyboardEvent.SwitchMode({ mode: "append" }),
        KeyboardEvent.KeyPress({ key: "a" }),
        KeyboardEvent.Clear,
        KeyboardEvent.KeyPress({ key: "b" }),
      ]);

      expect((result.finalState as KeyboardState & { _tag: "Typing" }).mode).toBe("append");
    }),
  );
});
