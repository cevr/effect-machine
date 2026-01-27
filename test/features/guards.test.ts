// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Guard, Machine, simulate, State, type TransitionContext } from "../../src/index.js";

describe("Named Guards (Effect Slots)", () => {
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

  test("guard slot registered in effectSlots", () => {
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"));

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
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"));

    // This should type-check - guards return Effect<boolean>
    const provided = Machine.provide(machine, {
      canPrint: ({ state }) =>
        // Narrow state to Ready variant to access canPrint
        state._tag === "Ready" ? Effect.succeed(state.canPrint) : Effect.succeed(false),
    });

    // Guard handler should be in guardHandlers map
    expect(provided.guardHandlers.size).toBe(1);
    expect(provided.guardHandlers.has("canPrint")).toBe(true);
  });

  test("multiple guard slots compose correctly", () => {
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(
      Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"),
      Machine.guard(TestState.Ready, TestEvent.Print, "hasPermission"),
    );

    expect(machine.effectSlots.size).toBe(2);
    expect(machine.effectSlots.has("canPrint")).toBe(true);
    expect(machine.effectSlots.has("hasPermission")).toBe(true);
  });

  test("mixed slots (guard + invoke) work together", () => {
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(
      Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"),
      Machine.invoke(TestState.Printing, "doPrint"),
    );

    expect(machine.effectSlots.size).toBe(2);

    const guardSlot = machine.effectSlots.get("canPrint");
    expect(guardSlot?.type).toBe("guard");

    const invokeSlot = machine.effectSlots.get("doPrint");
    expect(invokeSlot?.type).toBe("invoke");
  });

  test("provide() requires all slots including guards", () => {
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(
      Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"),
      Machine.invoke(TestState.Printing, "doPrint"),
    );

    // TypeScript now catches missing guard at compile time
    // Runtime also throws if somehow bypassed
    expect(() => {
      Machine.provide(
        machine,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- testing runtime error
        { doPrint: () => Effect.void } as any,
      );
    }).toThrow('Missing handler for effect slot "canPrint"');
  });

  test("guard handler stored separately from other effects", () => {
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Ready({ canPrint: true }),
    }).pipe(
      Machine.guard(TestState.Ready, TestEvent.Print, "canPrint"),
      Machine.invoke(TestState.Printing, "doPrint"),
      Machine.on(TestState.Ready, TestEvent.Print, () => TestState.Printing()),
      Machine.on(TestState.Printing, TestEvent.Finish, () => TestState.Done()),
      Machine.final(TestState.Done),
    );

    const provided = Machine.provide(machine, {
      canPrint: ({ state }) =>
        state._tag === "Ready" ? Effect.succeed(state.canPrint) : Effect.succeed(false),
      doPrint: () => Effect.void,
    });

    // Guards go to guardHandlers, not onEnter/onExit
    expect(provided.guardHandlers.size).toBe(1);
    expect(provided.guardHandlers.has("canPrint")).toBe(true);

    // Invoke creates onEnter + onExit
    expect(provided.onEnter.length).toBe(1);
    expect(provided.onExit.length).toBe(1);
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
        }).pipe(
          Machine.on(TestState.Ready, TestEvent.Print, () => TestState.Printing(), {
            guard: canPrint,
          }),
        );

        const provided = Machine.provide(machine, {
          canPrint: ({ state }: TransitionContext<TestStateType, TestEventType>) =>
            Effect.succeed(state._tag === "Ready" ? state.canPrint : false),
        });

        const result = yield* simulate(provided, [TestEvent.Print()]);
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
        }).pipe(
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed(), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access()]);
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
        }).pipe(
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed(), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access()]);
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
        }).pipe(
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed(), {
            guard: Guard.or(isAdmin, isModerator),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access()]);
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
        }).pipe(
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed(), {
            guard: Guard.not(isGuest),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("Guard.for auto-narrows types from constructors", async () => {
    // Guard.for infers types from constructors - no manual type annotations needed
    const isAdmin = Guard.for(
      AuthState.Idle,
      AuthEvent.Access,
    )(({ state }) => state.role === "admin");
    const isAdult = Guard.for(AuthState.Idle, AuthEvent.Access)(({ state }) => state.age >= 18);

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          initial: AuthState.Idle({ role: "admin", age: 25 }),
        }).pipe(
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed(), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });
});
