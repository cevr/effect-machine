import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Guard, Machine, simulate, State } from "../../src/index.js";

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
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed({}), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access({})]);
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
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed({}), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access({})]);
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
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed({}), {
            guard: Guard.or(isAdmin, isModerator),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access({})]);
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
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed({}), {
            guard: Guard.not(isGuest),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access({})]);
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
          Machine.on(AuthState.Idle, AuthEvent.Access, () => AuthState.Allowed({}), {
            guard: Guard.and(isAdmin, isAdult),
          }),
          Machine.final(AuthState.Allowed),
        );

        const result = yield* simulate(machine, [AuthEvent.Access({})]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });
});
