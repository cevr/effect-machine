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

  const sessionMachine = Machine.make({
    state: SessionState,
    event: SessionEvent,
    initial: SessionState.Initializing({ token: null }),
  })
    .always(SessionState.Initializing, [
      { guard: (state) => state.token === null, to: () => SessionState.Guest },
    ])
    .on(SessionState.Initializing, SessionEvent.TokenValidated, ({ event }) =>
      SessionState.Active({ userId: event.userId, role: event.role, lastActivity: Date.now() }),
    )
    .on(SessionState.Active, SessionEvent.MaintenanceStarted, ({ event }) =>
      SessionState.Maintenance({ message: event.message, previousState: "Active" }),
    )
    .on(SessionState.Guest, SessionEvent.MaintenanceStarted, ({ event }) =>
      SessionState.Maintenance({ message: event.message, previousState: "Guest" }),
    )
    .on(SessionState.Active, SessionEvent.SessionTimeout, () => SessionState.SessionExpired)
    .delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout)
    .on(SessionState.Maintenance, SessionEvent.MaintenanceEnded, ({ state }) =>
      state.previousState === "Active"
        ? SessionState.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
        : SessionState.Guest,
    )
    .on(SessionState.Active, SessionEvent.Logout, () => SessionState.LoggedOut)
    .final(SessionState.SessionExpired)
    .final(SessionState.LoggedOut);

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
      })
        .always(SessionState.Initializing, [
          { guard: (state) => state.token === null, to: () => SessionState.Guest },
        ])
        .on(SessionState.Initializing, SessionEvent.TokenValidated, ({ event }) =>
          SessionState.Active({ userId: event.userId, role: event.role, lastActivity: Date.now() }),
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
    })
      .on(SessionState.Active, SessionEvent.MaintenanceStarted, ({ event }) =>
        SessionState.Maintenance({ message: event.message, previousState: "Active" }),
      )
      .on(SessionState.Maintenance, SessionEvent.MaintenanceEnded, ({ state }) =>
        state.previousState === "Active"
          ? SessionState.Active({ userId: "restored", role: "user", lastActivity: Date.now() })
          : SessionState.Guest,
      );

    return assertPath(
      machineWithToken,
      [
        SessionEvent.MaintenanceStarted({ message: "System upgrade" }),
        SessionEvent.MaintenanceEnded,
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
      })
        .on(SessionState.Active, SessionEvent.SessionTimeout, () => SessionState.SessionExpired)
        .delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout)
        .final(SessionState.SessionExpired);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("session", activeMachine);

      let state = yield* actor.state.get;
      expect(state._tag).toBe("Active");

      // Activity within timeout window
      yield* TestClock.adjust("15 minutes");
      yield* actor.send(SessionEvent.Activity);
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
      })
        .delay(SessionState.Active, "30 minutes", SessionEvent.SessionTimeout)
        .on(SessionState.Active, SessionEvent.SessionTimeout, () => SessionState.SessionExpired)
        // Use on.force to reenter the state, resetting the delay timer
        .on.force(SessionState.Active, SessionEvent.Activity, ({ state }) =>
          SessionState.Active({ ...state, lastActivity: Date.now() }),
        )
        .final(SessionState.SessionExpired);

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("session", activeMachine);

      // Activity after 20 minutes
      yield* TestClock.adjust("20 minutes");
      yield* actor.send(SessionEvent.Activity);
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
    })
      .on(SessionState.Active, SessionEvent.Logout, () => SessionState.LoggedOut)
      .final(SessionState.LoggedOut);

    return assertPath(activeMachine, [SessionEvent.Logout], ["Active", "LoggedOut"]);
  });
});
