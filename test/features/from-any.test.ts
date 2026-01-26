// @effect-diagnostics strictEffectProvide:off
import { Data, Effect } from "effect";
import { describe, expect, test } from "bun:test";

import { Machine, build, simulate } from "../../src/index.js";

// ============================================================================
// Test fixtures
// ============================================================================

type EditorState = Data.TaggedEnum<{
  Idle: {};
  Typing: { text: string };
  Submitting: { text: string };
  Submitted: { text: string };
  Cancelled: {};
}>;
const State = Data.taggedEnum<EditorState>();

type EditorEvent = Data.TaggedEnum<{
  Focus: {};
  KeyPress: { key: string };
  Backspace: {};
  Submit: {};
  Cancel: {};
  Success: {};
}>;
const Event = Data.taggedEnum<EditorEvent>();

// ============================================================================
// from() tests
// ============================================================================

describe("Machine.from", () => {
  test("scopes multiple transitions to a single state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Idle()).pipe(
            Machine.on(State.Idle, Event.Focus, () => State.Typing({ text: "" })),
            Machine.from(State.Typing).pipe(
              Machine.on(Event.KeyPress, ({ state, event }) =>
                State.Typing({ text: state.text + event.key }),
              ),
              Machine.on(Event.Backspace, ({ state }) =>
                State.Typing({ text: state.text.slice(0, -1) }),
              ),
              Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          Event.Focus(),
          Event.KeyPress({ key: "h" }),
          Event.KeyPress({ key: "i" }),
          Event.Submit(),
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
        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Typing({ text: "" })).pipe(
            Machine.from(State.Typing).pipe(
              Machine.on(
                Event.KeyPress,
                ({ state, event }) => State.Typing({ text: state.text + event.key }),
                { guard: ({ state }) => state.text.length < 3 },
              ),
              Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          Event.KeyPress({ key: "a" }),
          Event.KeyPress({ key: "b" }),
          Event.KeyPress({ key: "c" }),
          Event.KeyPress({ key: "d" }), // blocked by guard
          Event.Submit(),
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

        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Typing({ text: "" })).pipe(
            Machine.from(State.Typing).pipe(
              Machine.on(
                Event.KeyPress,
                ({ state, event }) => State.Typing({ text: state.text + event.key }),
                {
                  effect: ({ event }) =>
                    Effect.sync(() => {
                      logs.push(`key: ${event.key}`);
                    }),
                },
              ),
              Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
            ),
          ),
        );

        yield* simulate(machine, [
          Event.KeyPress({ key: "h" }),
          Event.KeyPress({ key: "i" }),
          Event.Submit(),
        ]);

        expect(logs).toEqual(["key: h", "key: i"]);
      }),
    );
  });

  test("multiple from() scopes can be combined", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Idle()).pipe(
            Machine.from(State.Idle).pipe(
              Machine.on(Event.Focus, () => State.Typing({ text: "" })),
            ),
            Machine.from(State.Typing).pipe(
              Machine.on(Event.KeyPress, ({ state, event }) =>
                State.Typing({ text: state.text + event.key }),
              ),
              Machine.on(Event.Submit, ({ state }) => State.Submitting({ text: state.text })),
            ),
            Machine.from(State.Submitting).pipe(
              Machine.on(Event.Success, ({ state }) => State.Submitted({ text: state.text })),
            ),
          ),
        );

        const result = yield* simulate(machine, [
          Event.Focus(),
          Event.KeyPress({ key: "x" }),
          Event.Submit(),
          Event.Success(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("x");
        }
      }),
    );
  });
});

// ============================================================================
// any() tests
// ============================================================================

describe("Machine.any", () => {
  test("matches multiple states with single handler", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Typing({ text: "hello" })).pipe(
            Machine.on(State.Typing, Event.Submit, ({ state }) =>
              State.Submitting({ text: state.text }),
            ),
            Machine.on(Machine.any(State.Typing, State.Submitting), Event.Cancel, () =>
              State.Cancelled(),
            ),
          ),
        );

        // Cancel from Typing
        const result1 = yield* simulate(machine, [Event.Cancel()]);
        expect(result1.finalState._tag).toBe("Cancelled");

        // Cancel from Submitting
        const result2 = yield* simulate(machine, [Event.Submit(), Event.Cancel()]);
        expect(result2.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Typing({ text: "abc" })).pipe(
            Machine.on(State.Typing, Event.Submit, ({ state }) =>
              State.Submitting({ text: state.text }),
            ),
            Machine.on(
              Machine.any(State.Typing, State.Submitting),
              Event.Cancel,
              () => State.Cancelled(),
              // Guard tests state has text field - both Typing and Submitting have it
              { guard: ({ state }) => "text" in state && state.text.length > 0 },
            ),
          ),
        );

        const result = yield* simulate(machine, [Event.Cancel()]);
        expect(result.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = build(
          Machine.make<EditorState, EditorEvent>(State.Typing({ text: "" })).pipe(
            Machine.on(State.Typing, Event.Submit, ({ state }) =>
              State.Submitting({ text: state.text }),
            ),
            Machine.on(
              Machine.any(State.Typing, State.Submitting),
              Event.Cancel,
              () => State.Cancelled(),
              {
                effect: ({ state }) =>
                  Effect.sync(() => {
                    logs.push(`cancelled from: ${state._tag}`);
                  }),
              },
            ),
          ),
        );

        yield* simulate(machine, [Event.Cancel()]);
        expect(logs).toEqual(["cancelled from: Typing"]);

        logs.length = 0;
        yield* simulate(machine, [Event.Submit(), Event.Cancel()]);
        expect(logs).toEqual(["cancelled from: Submitting"]);
      }),
    );
  });

  test("any() creates separate transitions (3+ states)", async () => {
    type MultiState = Data.TaggedEnum<{
      A: {};
      B: {};
      C: {};
      D: {};
      Done: {};
    }>;
    const S = Data.taggedEnum<MultiState>();

    type MultiEvent = Data.TaggedEnum<{
      Next: {};
      Finish: {};
    }>;
    const E = Data.taggedEnum<MultiEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          Machine.make<MultiState, MultiEvent>(S.A()).pipe(
            Machine.on(S.A, E.Next, () => S.B()),
            Machine.on(S.B, E.Next, () => S.C()),
            Machine.on(S.C, E.Next, () => S.D()),
            Machine.on(Machine.any(S.A, S.B, S.C, S.D), E.Finish, () => S.Done()),
          ),
        );

        // Finish from A
        const r1 = yield* simulate(machine, [E.Finish()]);
        expect(r1.finalState._tag).toBe("Done");

        // Finish from B
        const r2 = yield* simulate(machine, [E.Next(), E.Finish()]);
        expect(r2.finalState._tag).toBe("Done");

        // Finish from C
        const r3 = yield* simulate(machine, [E.Next(), E.Next(), E.Finish()]);
        expect(r3.finalState._tag).toBe("Done");

        // Finish from D
        const r4 = yield* simulate(machine, [E.Next(), E.Next(), E.Next(), E.Finish()]);
        expect(r4.finalState._tag).toBe("Done");
      }),
    );
  });
});

// ============================================================================
// Namespace import tests
// ============================================================================

describe("Machine namespace", () => {
  test("Machine namespace exports all combinators", () => {
    expect(Machine.make).toBeDefined();
    expect(Machine.build).toBeDefined();
    expect(Machine.on).toBeDefined();
    expect(Machine.on.force).toBeDefined();
    expect(Machine.from).toBeDefined();
    expect(Machine.any).toBeDefined();
    expect(Machine.final).toBeDefined();
    expect(Machine.always).toBeDefined();
    expect(Machine.choose).toBeDefined();
    expect(Machine.delay).toBeDefined();
    expect(Machine.onEnter).toBeDefined();
    expect(Machine.onExit).toBeDefined();
    expect(Machine.assign).toBeDefined();
    expect(Machine.update).toBeDefined();
    expect(Machine.invoke).toBeDefined();
  });

  test("full Machine namespace usage", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.build(
          Machine.make<EditorState, EditorEvent>(State.Idle()).pipe(
            Machine.from(State.Idle).pipe(
              Machine.on(Event.Focus, () => State.Typing({ text: "" })),
            ),
            Machine.from(State.Typing).pipe(
              Machine.on(Event.KeyPress, ({ state, event }) =>
                State.Typing({ text: state.text + event.key }),
              ),
              Machine.on(Event.Submit, ({ state }) => State.Submitted({ text: state.text })),
            ),
            Machine.on(Machine.any(State.Idle, State.Typing), Event.Cancel, () =>
              State.Cancelled(),
            ),
            Machine.final(State.Submitted),
            Machine.final(State.Cancelled),
          ),
        );

        const result = yield* simulate(machine, [
          Event.Focus(),
          Event.KeyPress({ key: "!" }),
          Event.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("!");
        }
      }),
    );
  });
});
