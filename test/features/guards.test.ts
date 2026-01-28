// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Guard, Machine, simulate, State } from "../../src/index.js";
import type { TransitionContext } from "../../src/index.js";

describe("Named Guards (via on options)", () => {
  const TestState = State({
    Ready: { canPrint: Schema.Boolean },
    Printing: {},
    Done: {},
  });
  type TestStateType = typeof TestState.Type;

  const TestEvent = Event({
    Print: {},
    Finish: {},
  });
  type TestEventType = typeof TestEvent.Type;

  test("guard slot registered via on() with named guard", () => {
    const canPrint = Guard.make<
      { readonly _tag: "Ready"; readonly canPrint: boolean },
      { readonly _tag: "Print" }
    >("canPrint");

    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).on(TestState.Ready, TestEvent.Print, () => TestState.Printing, {
      guard: canPrint,
    });

    expect(machine.effectSlots.size).toBe(1);

    const slot = machine.effectSlots.get("canPrint");
    expect(slot).toBeDefined();
    expect(slot?.type).toBe("guard");
    expect(slot?.name).toBe("canPrint");

    // Guard slot has stateTag and eventTag
    if (slot?.type === "guard") {
      expect(slot.stateTag).toBe("Ready");
      expect(slot.eventTag).toBe("Print");
    }
  });

  test("provide() accepts Effect<boolean> for guard", () => {
    const canPrint = Guard.make<
      { readonly _tag: "Ready"; readonly canPrint: boolean },
      { readonly _tag: "Print" }
    >("canPrint");

    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).on(TestState.Ready, TestEvent.Print, () => TestState.Printing, {
      guard: canPrint,
    });

    // This should type-check - guards return Effect<boolean>
    const provided = machine.provide({
      canPrint: ({ state }: TransitionContext<TestStateType, TestEventType>) =>
        // Narrow state to Ready variant to access canPrint
        state._tag === "Ready" ? Effect.succeed(state.canPrint) : Effect.succeed(false),
    });

    // Guard handler should be in guardHandlers map
    expect(provided.guardHandlers.size).toBe(1);
    expect(provided.guardHandlers.has("canPrint")).toBe(true);
  });

  test("named guard slot blocks transition when handler returns false", async () => {
    const canPrint = Guard.make<
      {
        readonly _tag: "Ready";
        readonly canPrint: boolean;
      },
      { readonly _tag: "Print" }
    >("canPrint");

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Ready({ canPrint: false }),
        })
          .on(TestState.Ready, TestEvent.Print, () => TestState.Printing, {
            guard: canPrint,
          })
          .provide({
            canPrint: ({ state }: TransitionContext<TestStateType, TestEventType>) =>
              Effect.succeed(state._tag === "Ready" ? state.canPrint : false),
          });

        const result = yield* simulate(machine, [TestEvent.Print]);
        expect(result.finalState._tag).toBe("Ready");
      }),
    );
  });

  test("inline predicate guard works without named slot", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          initial: TestState.Ready({ canPrint: false }),
        }).on(TestState.Ready, TestEvent.Print, () => TestState.Printing, {
          guard: Guard.make(({ state }) => state._tag === "Ready" && state.canPrint),
        });

        const result = yield* simulate(machine, [TestEvent.Print]);
        expect(result.finalState._tag).toBe("Ready");
      }),
    );
  });
});

describe("Guard Composition", () => {
  const AuthState = State({
    Idle: { role: Schema.String, age: Schema.Number },
    Allowed: {},
    Denied: {},
  });
  type AuthState = typeof AuthState.Type;

  const AuthEvent = Event({
    Access: {},
  });
  type AuthEvent = typeof AuthEvent.Type;

  // Define narrowed types for the Idle state
  type IdleState = AuthState & { readonly _tag: "Idle" };
  type AccessEvent = AuthEvent & { readonly _tag: "Access" };

  test("Guard.and combines guards with logical AND", async () => {
    // Type guards narrowed to Idle state
    const isAdmin = Guard.make<IdleState, AccessEvent>(({ state }) => state.role === "admin");
    const isAdult = Guard.make<IdleState, AccessEvent>(({ state }) => state.age >= 18);

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "admin", age: 25 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed, {
            guard: Guard.and(isAdmin, isAdult),
          })
          .final(AuthState.Allowed);

        const result = yield* simulate(machine, [AuthEvent.Access]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );

    // Fails when one condition is false
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "admin", age: 16 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed, {
            guard: Guard.and(isAdmin, isAdult),
          })
          .final(AuthState.Allowed);

        const result = yield* simulate(machine, [AuthEvent.Access]);
        expect(result.finalState._tag).toBe("Idle");
      }),
    );
  });

  test("Guard.or combines guards with logical OR", async () => {
    const isAdmin = Guard.make<IdleState, AccessEvent>(({ state }) => state.role === "admin");
    const isModerator = Guard.make<IdleState, AccessEvent>(
      ({ state }) => state.role === "moderator",
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "moderator", age: 20 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed, {
            guard: Guard.or(isAdmin, isModerator),
          })
          .final(AuthState.Allowed);

        const result = yield* simulate(machine, [AuthEvent.Access]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("Guard.not negates a guard", async () => {
    const isGuest = Guard.make<IdleState, AccessEvent>(({ state }) => state.role === "guest");

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "user", age: 20 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed, {
            guard: Guard.not(isGuest),
          })
          .final(AuthState.Allowed);

        const result = yield* simulate(machine, [AuthEvent.Access]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("inline guard gets narrowed types from on() params", async () => {
    // With fluent on(), guards get narrowed types from state/event params
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "admin", age: 25 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed, {
            // Guard predicate is narrowed to IdleState & AccessEvent
            guard: ({ state }) => state.role === "admin" && state.age >= 18,
          })
          .final(AuthState.Allowed);

        const result = yield* simulate(machine, [AuthEvent.Access]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });
});
