// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Data, Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  assertPath,
  Machine,
  yieldFibers,
} from "../../src/index.js";

/**
 * Session lifecycle pattern tests based on bite session.machine.ts
 * Tests: initial state calculation via always, maintenance interrupt, session timeout
 */
describe("Session Lifecycle Pattern", () => {
  type UserRole = "guest" | "user" | "admin";

  type SessionState = Data.TaggedEnum<{
    Initializing: { token: string | null };
    Guest: {};
    Active: { userId: string; role: UserRole; lastActivity: number };
    Maintenance: { message: string; previousState: "Guest" | "Active" };
    SessionExpired: {};
    LoggedOut: {};
  }>;
  const State = Data.taggedEnum<SessionState>();

  type SessionEvent = Data.TaggedEnum<{
    TokenValidated: { userId: string; role: UserRole };
    TokenInvalid: {};
    Activity: {};
    MaintenanceStarted: { message: string };
    MaintenanceEnded: {};
    SessionTimeout: {};
    Logout: {};
  }>;
  const Event = Data.taggedEnum<SessionEvent>();

  const sessionMachine = Machine.build(
    Machine.make<SessionState, SessionEvent>(State.Initializing({ token: null })).pipe(
      // Always transition: if no token, go straight to Guest
      Machine.always(State.Initializing, [
        { guard: (state) => state.token === null, to: () => State.Guest() },
      ]),

      // Initializing state handlers
      Machine.from(State.Initializing).pipe(
        Machine.on(Event.TokenValidated, ({ event }) =>
          State.Active({ userId: event.userId, role: event.role, lastActivity: Date.now() }),
        ),
        Machine.on(Event.TokenInvalid, () => State.Guest()),
      ),

      // Active state handlers
      Machine.from(State.Active).pipe(
        Machine.on(Event.Activity, ({ state }) =>
          State.Active({ ...state, lastActivity: Date.now() }),
        ),
        Machine.on(Event.SessionTimeout, () => State.SessionExpired()),
        Machine.on(Event.MaintenanceStarted, ({ event }) =>
          State.Maintenance({ message: event.message, previousState: "Active" }),
        ),
        Machine.on(Event.Logout, () => State.LoggedOut()),
      ),

      // Session timeout delay
      Machine.delay(State.Active, "30 minutes", Event.SessionTimeout()),

      // Guest state handlers
      Machine.from(State.Guest).pipe(
        Machine.on(Event.MaintenanceStarted, ({ event }) =>
          State.Maintenance({ message: event.message, previousState: "Guest" }),
        ),
        Machine.on(Event.Logout, () => State.LoggedOut()),
      ),

      // Maintenance state handler
      Machine.on(State.Maintenance, Event.MaintenanceEnded, ({ state }) =>
        state.previousState === "Active"
          ? State.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
          : State.Guest(),
      ),

      Machine.final(State.SessionExpired),
      Machine.final(State.LoggedOut),
    ),
  );

  test("always transition calculates initial state from no token", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Machine starts with Initializing({ token: null })
        // Always transition should immediately move to Guest
        const result = yield* assertPath(
          sessionMachine,
          [],
          ["Guest"], // Initial state resolved to Guest
        );
        expect(result.finalState._tag).toBe("Guest");
      }),
    );
  });

  test("valid token leads to active session", async () => {
    // Create machine with token
    const machineWithToken = Machine.build(
      Machine.make<SessionState, SessionEvent>(State.Initializing({ token: "valid-token" })).pipe(
        // With token, wait for validation
        Machine.always(State.Initializing, [
          { guard: (state) => state.token === null, to: () => State.Guest() },
        ]),

        Machine.from(State.Initializing).pipe(
          Machine.on(Event.TokenValidated, ({ event }) =>
            State.Active({ userId: event.userId, role: event.role, lastActivity: Date.now() }),
          ),
          Machine.on(Event.TokenInvalid, () => State.Guest()),
        ),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* assertPath(
          machineWithToken,
          [Event.TokenValidated({ userId: "user-123", role: "user" })],
          ["Initializing", "Active"],
        );
        expect(result.finalState._tag).toBe("Active");
      }),
    );
  });

  test("maintenance mode interrupts active session", async () => {
    const machineWithToken = Machine.build(
      Machine.make<SessionState, SessionEvent>(
        State.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
      ).pipe(
        Machine.on(State.Active, Event.MaintenanceStarted, ({ event }) =>
          State.Maintenance({ message: event.message, previousState: "Active" }),
        ),

        Machine.on(State.Maintenance, Event.MaintenanceEnded, ({ state }) =>
          state.previousState === "Active"
            ? State.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
            : State.Guest(),
        ),
      ),
    );

    await Effect.runPromise(
      assertPath(
        machineWithToken,
        [Event.MaintenanceStarted({ message: "System upgrade" }), Event.MaintenanceEnded()],
        ["Active", "Maintenance", "Active"],
      ),
    );
  });

  test("session timeout after inactivity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activeMachine = Machine.build(
          Machine.make<SessionState, SessionEvent>(
            State.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
          ).pipe(
            Machine.from(State.Active).pipe(
              Machine.on(Event.Activity, ({ state }) =>
                State.Active({ ...state, lastActivity: Date.now() }),
              ),
              Machine.on(Event.SessionTimeout, () => State.SessionExpired()),
            ),
            Machine.delay(State.Active, "30 minutes", Event.SessionTimeout()),
            Machine.final(State.SessionExpired),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("session", activeMachine);

        let state = yield* actor.state.get;
        expect(state._tag).toBe("Active");

        // Activity within timeout window
        yield* TestClock.adjust("15 minutes");
        yield* actor.send(Event.Activity());
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("Active");

        // Activity does NOT reset timer (internal transition)
        // So after 15 more minutes (30 total from start), should timeout
        yield* TestClock.adjust("15 minutes");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("SessionExpired");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("activity with reenter resets timeout", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activeMachine = Machine.build(
          Machine.make<SessionState, SessionEvent>(
            State.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
          ).pipe(
            Machine.on.force(State.Active, Event.Activity, ({ state }) =>
              State.Active({ ...state, lastActivity: Date.now() }),
            ),
            Machine.delay(State.Active, "30 minutes", Event.SessionTimeout()),
            Machine.on(State.Active, Event.SessionTimeout, () => State.SessionExpired()),
            Machine.final(State.SessionExpired),
          ),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("session", activeMachine);

        // Activity after 20 minutes
        yield* TestClock.adjust("20 minutes");
        yield* actor.send(Event.Activity());
        yield* yieldFibers;

        let state = yield* actor.state.get;
        expect(state._tag).toBe("Active");

        // 20 more minutes (40 total, but only 20 from activity)
        yield* TestClock.adjust("20 minutes");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("Active"); // Timer was reset

        // 10 more minutes (30 from activity)
        yield* TestClock.adjust("10 minutes");
        yield* yieldFibers;

        state = yield* actor.state.get;
        expect(state._tag).toBe("SessionExpired");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
      ),
    );
  });

  test("logout from active session", async () => {
    const activeMachine = Machine.build(
      Machine.make<SessionState, SessionEvent>(
        State.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
      ).pipe(
        Machine.on(State.Active, Event.Logout, () => State.LoggedOut()),
        Machine.final(State.LoggedOut),
      ),
    );

    await Effect.runPromise(assertPath(activeMachine, [Event.Logout()], ["Active", "LoggedOut"]));
  });
});
