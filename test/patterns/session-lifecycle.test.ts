// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema, TestClock } from "effect";

import {
  ActorSystemDefault,
  ActorSystemService,
  assertPath,
  Event,
  Machine,
  State,
} from "../../src/index.js";
import { describe, expect, it, yieldFibers } from "../utils/effect-test.js";

/**
 * Session lifecycle pattern tests based on bite session.machine.ts
 * Tests: initial state calculation via always, maintenance interrupt, session timeout
 */
describe("Session Lifecycle Pattern", () => {
  const UserRole = Schema.Literal("guest", "user", "admin");
  type UserRole = typeof UserRole.Type;

  const SessionState = State({
    Initializing: { token: Schema.NullOr(Schema.String) },
    Guest: {},
    Active: { userId: Schema.String, role: UserRole, lastActivity: Schema.Number },
    Maintenance: { message: Schema.String, previousState: Schema.Literal("Guest", "Active") },
    SessionExpired: {},
    LoggedOut: {},
  });
  type SessionState = typeof SessionState.Type;

  const SessionEvent = Event({
    TokenValidated: { userId: Schema.String, role: UserRole },
    TokenInvalid: {},
    Activity: {},
    MaintenanceStarted: { message: Schema.String },
    MaintenanceEnded: {},
    SessionTimeout: {},
    Logout: {},
  });
  type SessionEvent = typeof SessionEvent.Type;

  const sessionMachine = Machine.make({
    state: SessionState,
    event: SessionEvent,
    initial: SessionState.Initializing({ token: null }),
  }).pipe(
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

  it.live("always transition calculates initial state from no token", () =>
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

  it.live("valid token leads to active session", () =>
    Effect.gen(function* () {
      // Create machine with token
      const machineWithToken = Machine.make({
        state: SessionState,
        event: SessionEvent,
        initial: SessionState.Initializing({ token: "valid-token" }),
      }).pipe(
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

      const result = yield* assertPath(
        machineWithToken,
        [SessionEvent.TokenValidated({ userId: "user-123", role: "user" })],
        ["Initializing", "Active"],
      );
      expect(result.finalState._tag).toBe("Active");
    }),
  );

  it.live("maintenance mode interrupts active session", () => {
    const machineWithToken = Machine.make({
      state: SessionState,
      event: SessionEvent,
      initial: SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
    }).pipe(
      Machine.on(SessionState.Active, SessionEvent.MaintenanceStarted, ({ event }) =>
        SessionState.Maintenance({ message: event.message, previousState: "Active" }),
      ),

      Machine.on(SessionState.Maintenance, SessionEvent.MaintenanceEnded, ({ state }) =>
        state.previousState === "Active"
          ? SessionState.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
          : SessionState.Guest(),
      ),
    );

    return assertPath(
      machineWithToken,
      [
        SessionEvent.MaintenanceStarted({ message: "System upgrade" }),
        SessionEvent.MaintenanceEnded(),
      ],
      ["Active", "Maintenance", "Active"],
    );
  });

  it.scoped("session timeout after inactivity", () =>
    Effect.gen(function* () {
      const activeMachine = Machine.make({
        state: SessionState,
        event: SessionEvent,
        initial: SessionState.Active({
          userId: "user-1",
          role: "user",
          lastActivity: Date.now(),
        }),
      }).pipe(
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
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("activity with reenter resets timeout", () =>
    Effect.gen(function* () {
      const activeMachine = Machine.make({
        state: SessionState,
        event: SessionEvent,
        initial: SessionState.Active({
          userId: "user-1",
          role: "user",
          lastActivity: Date.now(),
        }),
      }).pipe(
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
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.live("logout from active session", () => {
    const activeMachine = Machine.make({
      state: SessionState,
      event: SessionEvent,
      initial: SessionState.Active({ userId: "user-1", role: "user", lastActivity: Date.now() }),
    }).pipe(
      Machine.on(SessionState.Active, SessionEvent.Logout, () => SessionState.LoggedOut()),
      Machine.final(SessionState.LoggedOut),
    );

    return assertPath(activeMachine, [SessionEvent.Logout()], ["Active", "LoggedOut"]);
  });
});
