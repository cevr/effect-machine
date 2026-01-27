import { Effect } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State } from "../../src/index.js";

// ============================================================================
// Test fixtures
// ============================================================================

type EditorState = State<{
  Idle: {};
  Typing: { text: string };
  Submitting: { text: string };
  Submitted: { text: string };
  Cancelled: {};
}>;
const EditorState = State<EditorState>();

type EditorEvent = Event<{
  Focus: {};
  KeyPress: { key: string };
  Backspace: {};
  Submit: {};
  Cancel: {};
  Success: {};
}>;
const EditorEvent = Event<EditorEvent>();

// ============================================================================
// from() tests
// ============================================================================

describe("Machine.from", () => {
  test("scopes multiple transitions to a single state", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<EditorState, EditorEvent>(EditorState.Idle()).pipe(
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
          EditorEvent.Focus(),
          EditorEvent.KeyPress({ key: "h" }),
          EditorEvent.KeyPress({ key: "i" }),
          EditorEvent.Submit(),
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
        const machine = Machine.make<EditorState, EditorEvent>(
          EditorState.Typing({ text: "" }),
        ).pipe(
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
          EditorEvent.Submit(),
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

        const machine = Machine.make<EditorState, EditorEvent>(
          EditorState.Typing({ text: "" }),
        ).pipe(
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
          EditorEvent.Submit(),
        ]);

        expect(logs).toEqual(["key: h", "key: i"]);
      }),
    );
  });

  test("multiple from() scopes can be combined", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<EditorState, EditorEvent>(EditorState.Idle()).pipe(
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
          EditorEvent.Focus(),
          EditorEvent.KeyPress({ key: "x" }),
          EditorEvent.Submit(),
          EditorEvent.Success(),
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
        const machine = Machine.make<EditorState, EditorEvent>(
          EditorState.Typing({ text: "hello" }),
        ).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled(),
          ),
        );

        // Cancel from Typing
        const result1 = yield* simulate(machine, [EditorEvent.Cancel()]);
        expect(result1.finalState._tag).toBe("Cancelled");

        // Cancel from Submitting
        const result2 = yield* simulate(machine, [EditorEvent.Submit(), EditorEvent.Cancel()]);
        expect(result2.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with guards", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<EditorState, EditorEvent>(
          EditorState.Typing({ text: "abc" }),
        ).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled(),
            // Guard tests state has text field - both Typing and Submitting have it
            { guard: ({ state }) => "text" in state && state.text.length > 0 },
          ),
        );

        const result = yield* simulate(machine, [EditorEvent.Cancel()]);
        expect(result.finalState._tag).toBe("Cancelled");
      }),
    );
  });

  test("any() works with effects", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const logs: string[] = [];

        const machine = Machine.make<EditorState, EditorEvent>(
          EditorState.Typing({ text: "" }),
        ).pipe(
          Machine.on(EditorState.Typing, EditorEvent.Submit, ({ state }) =>
            EditorState.Submitting({ text: state.text }),
          ),
          Machine.on(
            Machine.any(EditorState.Typing, EditorState.Submitting),
            EditorEvent.Cancel,
            () => EditorState.Cancelled(),
            {
              effect: ({ state }) =>
                Effect.sync(() => {
                  logs.push(`cancelled from: ${state._tag}`);
                }),
            },
          ),
        );

        yield* simulate(machine, [EditorEvent.Cancel()]);
        expect(logs).toEqual(["cancelled from: Typing"]);

        logs.length = 0;
        yield* simulate(machine, [EditorEvent.Submit(), EditorEvent.Cancel()]);
        expect(logs).toEqual(["cancelled from: Submitting"]);
      }),
    );
  });

  test("any() creates separate transitions (3+ states)", async () => {
    type MultiState = State<{
      A: {};
      B: {};
      C: {};
      D: {};
      Done: {};
    }>;
    const S = State<MultiState>();

    type MultiEvent = Event<{
      Next: {};
      Finish: {};
    }>;
    const E = Event<MultiEvent>();

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make<MultiState, MultiEvent>(S.A()).pipe(
          Machine.on(S.A, E.Next, () => S.B()),
          Machine.on(S.B, E.Next, () => S.C()),
          Machine.on(S.C, E.Next, () => S.D()),
          Machine.on(Machine.any(S.A, S.B, S.C, S.D), E.Finish, () => S.Done()),
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
    expect(Machine.provide).toBeDefined();
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
        const machine = Machine.make<EditorState, EditorEvent>(EditorState.Idle()).pipe(
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
            EditorState.Cancelled(),
          ),
          Machine.final(EditorState.Submitted),
          Machine.final(EditorState.Cancelled),
        );

        const result = yield* simulate(machine, [
          EditorEvent.Focus(),
          EditorEvent.KeyPress({ key: "!" }),
          EditorEvent.Submit(),
        ]);

        expect(result.finalState._tag).toBe("Submitted");
        if (result.finalState._tag === "Submitted") {
          expect(result.finalState.text).toBe("!");
        }
      }),
    );
  });
});
