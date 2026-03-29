// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import { Event, Machine, simulate, State, Slot } from "../src/index.js";

describe("Parameterized Slots (via Slot.define)", () => {
  const TestState = State({
    Ready: { canPrint: Schema.Boolean },
    Printing: {},
    Done: {},
  });

  const TestEvent = Event({
    Print: {},
    Finish: {},
  });

  const TestSlots = Slot.define({
    canPrint: Slot.fn({}, Schema.Boolean),
  });

  test("slot blocks transition when handler returns false", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          slots: TestSlots,
          initial: TestState.Ready({ canPrint: false }),
        }).on(TestState.Ready, TestEvent.Print, ({ state, slots }) =>
          Effect.gen(function* () {
            if (yield* slots.canPrint()) {
              return TestState.Printing;
            }
            return state;
          }),
        );

        const result = yield* simulate(machine, [TestEvent.Print], {
          slots: {
            canPrint: () => false,
          },
        });
        expect(result.finalState._tag).toBe("Ready");
      }),
    );
  });

  test("slot allows transition when handler returns true", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: TestState,
          event: TestEvent,
          slots: TestSlots,
          initial: TestState.Ready({ canPrint: true }),
        }).on(TestState.Ready, TestEvent.Print, ({ state, slots }) =>
          Effect.gen(function* () {
            if (yield* slots.canPrint()) {
              return TestState.Printing;
            }
            return state;
          }),
        );

        const result = yield* simulate(machine, [TestEvent.Print], {
          slots: {
            canPrint: () => true,
          },
        });
        expect(result.finalState._tag).toBe("Printing");
      }),
    );
  });
});

describe("Parameterized Slots with Parameters", () => {
  const AuthState = State({
    Idle: { role: Schema.String, age: Schema.Number },
    Allowed: {},
    Denied: {},
  });

  const AuthEvent = Event({
    Access: {},
  });

  const AuthSlots = Slot.define({
    isAdmin: Slot.fn({}, Schema.Boolean),
    isAdult: Slot.fn({ minAge: Schema.Number }, Schema.Boolean),
    isModerator: Slot.fn({}, Schema.Boolean),
  });

  test("slot with parameters: isAdult({ minAge: 18 })", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          slots: AuthSlots,
          initial: AuthState.Idle({ role: "admin", age: 25 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, ({ slots }) =>
            Effect.gen(function* () {
              const isAdmin = yield* slots.isAdmin();
              const isAdult = yield* slots.isAdult({ minAge: 18 });
              if (isAdmin && isAdult) {
                return AuthState.Allowed;
              }
              return AuthState.Denied;
            }),
          )
          .final(AuthState.Allowed)
          .final(AuthState.Denied);

        const authSlots = {
          isAdmin: () => true,
          isAdult: ({ minAge }: { minAge: number }) => minAge <= 25,
          isModerator: () => false,
        };

        const result = yield* simulate(machine, [AuthEvent.Access], { slots: authSlots });
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("combined slot logic with && / ||", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          slots: AuthSlots,
          initial: AuthState.Idle({ role: "moderator", age: 25 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, ({ slots }) =>
            Effect.gen(function* () {
              // (admin OR moderator) AND adult
              const isAdmin = yield* slots.isAdmin();
              const isMod = yield* slots.isModerator();
              const isAdult = yield* slots.isAdult({ minAge: 18 });
              if ((isAdmin || isMod) && isAdult) {
                return AuthState.Allowed;
              }
              return AuthState.Denied;
            }),
          )
          .final(AuthState.Allowed)
          .final(AuthState.Denied);

        const authSlots = {
          isAdmin: () => false,
          isAdult: ({ minAge }: { minAge: number }) => minAge <= 25,
          isModerator: () => true,
        };

        const result = yield* simulate(machine, [AuthEvent.Access], { slots: authSlots });
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("NOT logic with !", async () => {
    const LockedSlots = Slot.define({
      isGuest: Slot.fn({}, Schema.Boolean),
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = Machine.make({
          state: AuthState,
          event: AuthEvent,
          slots: LockedSlots,
          initial: AuthState.Idle({ role: "user", age: 20 }),
        })
          .on(AuthState.Idle, AuthEvent.Access, ({ slots }) =>
            Effect.gen(function* () {
              const isGuest = yield* slots.isGuest();
              // NOT guest = allowed
              if (!isGuest) {
                return AuthState.Allowed;
              }
              return AuthState.Denied;
            }),
          )
          .final(AuthState.Allowed)
          .final(AuthState.Denied);

        const result = yield* simulate(machine, [AuthEvent.Access], {
          slots: {
            isGuest: () => false,
          },
        });
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });
});
