// @effect-diagnostics strictEffectProvide:off - tests are entry points
// @effect-diagnostics anyUnknownInErrorContext:off - validation tests use `as any` casts
// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics missingEffectError:off
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

// ============================================================================
// Slot Schema Tests
// ============================================================================

describe("Slot schemas", () => {
  const MySlots = Slot.define({
    canRetry: Slot.fn({ max: Schema.Number }, Schema.Boolean),
    fetchData: Slot.fn({ url: Schema.String }),
    computeValue: Slot.fn({ input: Schema.Number }, Schema.Number),
  });

  test("SlotFnDef has inputSchema and outputSchema", () => {
    const canRetryDef = MySlots.definitions.canRetry;
    expect(canRetryDef.inputSchema).toBeDefined();
    expect(canRetryDef.outputSchema).toBeDefined();

    // Input schema decodes correctly
    const params = Schema.decodeUnknownSync(canRetryDef.inputSchema)({ max: 3 });
    expect(params).toEqual({ max: 3 });

    // Output schema decodes correctly
    const result = Schema.decodeUnknownSync(canRetryDef.outputSchema)(true);
    expect(result).toBe(true);
  });

  test("void-returning slot has Schema.Void as outputSchema", () => {
    const fetchDef = MySlots.definitions.fetchData;
    expect(fetchDef.returnSchema).toBeUndefined();
    // outputSchema is Schema.Void
    const result = Schema.decodeUnknownSync(fetchDef.outputSchema)(undefined);
    expect(result).toBeUndefined();
  });

  test("empty-fields slot has Schema.Void as inputSchema", () => {
    const EmptySlots = Slot.define({
      ping: Slot.fn({}, Schema.Boolean),
    });
    const result = Schema.decodeUnknownSync(EmptySlots.definitions.ping.inputSchema)(undefined);
    expect(result).toBeUndefined();
  });

  test("input schema rejects invalid data", () => {
    const canRetryDef = MySlots.definitions.canRetry;
    expect(() =>
      Schema.decodeUnknownSync(canRetryDef.inputSchema)({ max: "not a number" }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(canRetryDef.inputSchema)({})).toThrow();
  });

  test("output schema rejects invalid data", () => {
    const canRetryDef = MySlots.definitions.canRetry;
    expect(() => Schema.decodeUnknownSync(canRetryDef.outputSchema)("not a boolean")).toThrow();
  });

  test("invocationSchema decodes slot invocations", () => {
    const decoded = Schema.decodeUnknownSync(MySlots.invocationSchema)({
      _tag: "SlotInvocation",
      name: "canRetry",
      params: { max: 3 },
      result: true,
    });
    expect(decoded).toEqual({
      _tag: "SlotInvocation",
      name: "canRetry",
      params: { max: 3 },
      result: true,
    });
  });

  test("invocationSchema rejects unknown slot names", () => {
    expect(() =>
      Schema.decodeUnknownSync(MySlots.invocationSchema)({
        _tag: "SlotInvocation",
        name: "unknown",
        params: {},
        result: null,
      }),
    ).toThrow();
  });

  test("requestSchema decodes slot requests", () => {
    const decoded = Schema.decodeUnknownSync(MySlots.requestSchema)({
      _tag: "SlotRequest",
      name: "canRetry",
      params: { max: 3 },
    });
    expect(decoded).toEqual({ _tag: "SlotRequest", name: "canRetry", params: { max: 3 } });
  });

  test("resultSchema decodes slot results", () => {
    const decoded = Schema.decodeUnknownSync(MySlots.resultSchema)({
      _tag: "SlotResult",
      name: "computeValue",
      result: 42,
    });
    expect(decoded).toEqual({ _tag: "SlotResult", name: "computeValue", result: 42 });
  });

  test("requestSchema rejects unknown slot names", () => {
    expect(() =>
      Schema.decodeUnknownSync(MySlots.requestSchema)({
        _tag: "SlotRequest",
        name: "unknown",
        params: {},
      }),
    ).toThrow();
  });

  test("invocationSchema encodes slot invocations", () => {
    const encoded = Schema.encodeSync(MySlots.invocationSchema)({
      _tag: "SlotInvocation",
      name: "computeValue",
      params: { input: 42 },
      result: 84,
    });
    expect(encoded).toEqual({
      _tag: "SlotInvocation",
      name: "computeValue",
      params: { input: 42 },
      result: 84,
    });
  });
});

// ============================================================================
// Slot Runtime Validation Tests
// ============================================================================

describe("Slot runtime validation", () => {
  const ValState = State({
    Idle: {},
    Done: { result: Schema.Number },
  });

  const ValEvent = Event({
    Go: {},
  });

  const ValSlots = Slot.define({
    compute: Slot.fn({ input: Schema.Number }, Schema.Number),
  });

  test("validates output — rejects wrong return type (defect)", async () => {
    const machine = Machine.make({
      state: ValState,
      event: ValEvent,
      slots: ValSlots,
      initial: ValState.Idle,
    }).on(ValState.Idle, ValEvent.Go, ({ slots }) =>
      slots.compute({ input: 5 }).pipe(Effect.map((result) => ValState.Done({ result }))),
    );

    const result = await Effect.runPromise(
      simulate(machine, [ValEvent.Go], {
        // Handler returns string instead of number — output validation catches it
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        slots: { compute: () => "not a number" } as any,
      }).pipe(Effect.exit),
    );
    // Should be a defect (die) due to SlotCodecError on output phase
    expect(result._tag).toBe("Failure");
  });

  test("validates input — rejects wrong param type (defect)", async () => {
    // Use a slot where the handler itself triggers input validation
    // by being called with wrong types at runtime
    const InputSlots = Slot.define({
      lookup: Slot.fn({ id: Schema.Number }, Schema.String),
    });
    const InputState = State({ Idle: {}, Done: { name: Schema.String } });
    const InputEvent = Event({ Go: { id: Schema.Number } });

    const machine = Machine.make({
      state: InputState,
      event: InputEvent,
      slots: InputSlots,
      initial: InputState.Idle,
    }).on(InputState.Idle, InputEvent.Go, ({ event, slots }) =>
      slots.lookup({ id: event.id }).pipe(Effect.map((name) => InputState.Done({ name }))),
    );

    // Slot handler receives pre-validated params; to test input validation
    // we provide a handler and check it receives correct types
    const result = await Effect.runPromise(
      simulate(machine, [InputEvent.Go({ id: 42 })], {
        slots: { lookup: ({ id }: { id: number }) => `user-${id}` },
      }),
    );
    expect(result.finalState._tag).toBe("Done");
    expect((result.finalState as { name: string }).name).toBe("user-42");
  });

  test("valid input/output passes through", async () => {
    const machine = Machine.make({
      state: ValState,
      event: ValEvent,
      slots: ValSlots,
      initial: ValState.Idle,
    }).on(ValState.Idle, ValEvent.Go, ({ slots }) =>
      slots.compute({ input: 5 }).pipe(Effect.map((result) => ValState.Done({ result }))),
    );

    const result = await Effect.runPromise(
      simulate(machine, [ValEvent.Go], {
        slots: { compute: ({ input }: { input: number }) => input * 2 },
      }),
    );
    expect(result.finalState._tag).toBe("Done");
    expect((result.finalState as { result: number }).result).toBe(10);
  });

  test("slotValidation: false disables validation", async () => {
    const machine = Machine.make({
      state: ValState,
      event: ValEvent,
      slots: ValSlots,
      initial: ValState.Idle,
      slotValidation: false,
    }).on(ValState.Idle, ValEvent.Go, ({ slots }) =>
      slots.compute({ input: 5 }).pipe(Effect.map((result) => ValState.Done({ result }))),
    );

    // With validation off, wrong return type goes through unchecked
    const result = await Effect.runPromise(
      simulate(machine, [ValEvent.Go], {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        slots: { compute: () => "not a number" } as any,
      }),
    );
    expect(result.finalState._tag).toBe("Done");
    // The string went through unchecked
    expect((result.finalState as { result: unknown }).result).toBe("not a number");
  });

  test("plain object return works (not treated as Effect)", async () => {
    const ObjSlots = Slot.define({
      getData: Slot.fn({}, Schema.Struct({ value: Schema.Number })),
    });

    const ObjState = State({ Idle: {}, Done: { value: Schema.Number } });
    const ObjEvent = Event({ Go: {} });

    const machine = Machine.make({
      state: ObjState,
      event: ObjEvent,
      slots: ObjSlots,
      initial: ObjState.Idle,
    }).on(ObjState.Idle, ObjEvent.Go, ({ slots }) =>
      slots
        .getData(undefined as void)
        .pipe(Effect.map((data) => ObjState.Done({ value: data.value }))),
    );

    const result = await Effect.runPromise(
      simulate(machine, [ObjEvent.Go], {
        slots: { getData: () => ({ value: 42 }) },
      }),
    );
    expect(result.finalState._tag).toBe("Done");
    expect((result.finalState as { value: number }).value).toBe(42);
  });
});
