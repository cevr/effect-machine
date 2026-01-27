// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Layer, TestClock, TestContext } from "effect";
import { describe, expect, test } from "bun:test";

import {
  ActorSystemDefault,
  ActorSystemService,
  assertPath,
  Event,
  Machine,
  State,
  yieldFibers,
} from "../../src/index.js";

/**
 * Session lifecycle pattern tests based on bite session.machine.ts
 * Tests: initial state calculation via always, maintenance interrupt, session timeout
 */
describe("Session Lifecycle Pattern", () => {
  type UserRole = "guest" | "user" | "admin";

  type SessionState = State<{
    Initializing: { token: string | null };
    Guest: {};
    Active: { userId: string; role: UserRole; lastActivity: number };
    Maintenance: { message: string; previousState: "Guest" | "Active" };
    SessionExpired: {};
    LoggedOut: {};
  }>;
  const SessionState = State<SessionState>();

  type SessionEvent = Event<{
    TokenValidated: { userId: string; role: UserRole };
    TokenInvalid: {};
    Activity: {};
    MaintenanceStarted: { message: string };
    MaintenanceEnded: {};
    SessionTimeout: {};
    Logout: {};
  }>;
  const SessionEvent = Event<SessionEvent>();

  const sessionMachine = Machine.make<SessionState, SessionEvent>(
    SessionState.Initializing({ token: null }),
  ).pipe(
    // Always transition: if no token, go straight to Guest
    Machine.always(SessionState.Initializing, [
      { guard: (state) => state.token === null, to: () => SessionState.Guest() },
    ]),

    // Initializing state handlers
    Machine.from(SessionState.Initializing).pipe(
      Machine.on(SessionEvent.TokenValidated, ({ event }) =>
        SessionState.Active({ userId: event.userId, role: event.role, lastActivity: Date.now() }),
      ),
      Machine.on(SessionEvent.TokenInvalid, () => SessionState.Guest()),
    ),

    // Active state handlers
    Machine.from(SessionState.Active).pipe(
      Machine.on(SessionEvent.Activity, ({ state }) =>
        SessionState.Active({ ...state, lastActivity: Date.now() }),
      ),
      Machine.on(SessionEvent.SessionTimeout, () => SessionState.SessionExpired()),
      Machine.on(SessionEvent.MaintenanceStarted, ({ event }) =>
        SessionState.Maintenance({ message: event.message, previousState: "Active" }),
      ),
      Machine.on(SessionEvent.Logout, () => SessionState.LoggedOut()),
    ),

    // Session timeout delay
    Machine.delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout()),

    // Guest state handlers
    Machine.from(SessionState.Guest).pipe(
      Machine.on(SessionEvent.MaintenanceStarted, ({ event }) =>
        SessionState.Maintenance({ message: event.message, previousState: "Guest" }),
      ),
      Machine.on(SessionEvent.Logout, () => SessionState.LoggedOut()),
    ),

    // Maintenance state handler
    Machine.on(SessionState.Maintenance, SessionEvent.MaintenanceEnded, ({ state }) =>
      state.previousState === "Active"
        ? SessionState.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
        : SessionState.Guest(),
    ),

    Machine.final(SessionState.SessionExpired),
    Machine.final(SessionState.LoggedOut),
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
    const machineWithToken = Machine.make<SessionState, SessionEvent>(
      SessionState.Initializing({ token: "valid-token" }),
    ).pipe(
      // With token, wait for validation
      Machine.always(SessionState.Initializing, [
        { guard: (state) => state.token === null, to: () => SessionState.Guest() },
      ]),

      Machine.from(SessionState.Initializing).pipe(
        Machine.on(SessionEvent.TokenValidated, ({ event }) =>
          SessionState.Active({
            userId: event.userId,
            role: event.role,
            lastActivity: Date.now(),
          }),
        ),
        Machine.on(SessionEvent.TokenInvalid, () => SessionState.Guest()),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* assertPath(
          machineWithToken,
          [SessionEvent.TokenValidated({ userId: "user-123", role: "user" })],
          ["Initializing", "Active"],
        );
        expect(result.finalState._tag).toBe("Active");
      }),
    );
  });

  test("maintenance mode interrupts active session", async () => {
    const machineWithToken = Machine.make<SessionState, SessionEvent>(
      SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
    ).pipe(
      Machine.on(SessionState.Active, SessionEvent.MaintenanceStarted, ({ event }) =>
        SessionState.Maintenance({ message: event.message, previousState: "Active" }),
      ),

      Machine.on(SessionState.Maintenance, SessionEvent.MaintenanceEnded, ({ state }) =>
        state.previousState === "Active"
          ? SessionState.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
          : SessionState.Guest(),
      ),
    );

    await Effect.runPromise(
      assertPath(
        machineWithToken,
        [
          SessionEvent.MaintenanceStarted({ message: "System upgrade" }),
          SessionEvent.MaintenanceEnded(),
        ],
        ["Active", "Maintenance", "Active"],
      ),
    );
  });

  test("session timeout after inactivity", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activeMachine = Machine.make<SessionState, SessionEvent>(
          SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
        ).pipe(
          Machine.from(SessionState.Active).pipe(
            Machine.on(SessionEvent.Activity, ({ state }) =>
              SessionState.Active({ ...state, lastActivity: Date.now() }),
            ),
            Machine.on(SessionEvent.SessionTimeout, () => SessionState.SessionExpired()),
          ),
          Machine.delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout()),
          Machine.final(SessionState.SessionExpired),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("session", activeMachine);

        let state = yield* actor.state.get;
        expect(state._tag).toBe("Active");

        // Activity within timeout window
        yield* TestClock.adjust("15 minutes");
        yield* actor.send(SessionEvent.Activity());
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
        const activeMachine = Machine.make<SessionState, SessionEvent>(
          SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
        ).pipe(
          Machine.on.force(SessionState.Active, SessionEvent.Activity, ({ state }) =>
            SessionState.Active({ ...state, lastActivity: Date.now() }),
          ),
          Machine.delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout()),
          Machine.on(SessionState.Active, SessionEvent.SessionTimeout, () =>
            SessionState.SessionExpired(),
          ),
          Machine.final(SessionState.SessionExpired),
        );

        const system = yield* ActorSystemService;
        const actor = yield* system.spawn("session", activeMachine);

        // Activity after 20 minutes
        yield* TestClock.adjust("20 minutes");
        yield* actor.send(SessionEvent.Activity());
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
    const activeMachine = Machine.make<SessionState, SessionEvent>(
      SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
    ).pipe(
      Machine.on(SessionState.Active, SessionEvent.Logout, () => SessionState.LoggedOut()),
      Machine.final(SessionState.LoggedOut),
    );

    await Effect.runPromise(
      assertPath(activeMachine, [SessionEvent.Logout()], ["Active", "LoggedOut"]),
    );
  });
});
