import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import { build, final, Guard, make, on, simulate } from "../../src/index.js";

describe("Guard Composition", () => {
  type State = Data.TaggedEnum<{
    Idle: { role: string; age: number };
    Allowed: {};
    Denied: {};
  }>;
  const State = Data.taggedEnum<State>();

  type Event = Data.TaggedEnum<{
    Access: {};
  }>;
  const Event = Data.taggedEnum<Event>();

  // Define narrowed types for the Idle state
  type IdleState = State & { readonly _tag: "Idle" };
  type AccessEvent = Event & { readonly _tag: "Access" };

  test("Guard.and combines guards with logical AND", async () => {
    // Type guards narrowed to Idle state
    const isAdmin = Guard.make<IdleState, AccessEvent>(({ state }) => state.role === "admin");
    const isAdult = Guard.make<IdleState, AccessEvent>(({ state }) => state.age >= 18);

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ role: "admin", age: 25 })),
            on(State.Idle, Event.Access, () => State.Allowed(), {
              guard: Guard.and(isAdmin, isAdult),
            }),
            final(State.Allowed),
          ),
        );

        const result = yield* simulate(machine, [Event.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );

    // Fails when one condition is false
    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ role: "admin", age: 16 })),
            on(State.Idle, Event.Access, () => State.Allowed(), {
              guard: Guard.and(isAdmin, isAdult),
            }),
            final(State.Allowed),
          ),
        );

        const result = yield* simulate(machine, [Event.Access()]);
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
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ role: "moderator", age: 20 })),
            on(State.Idle, Event.Access, () => State.Allowed(), {
              guard: Guard.or(isAdmin, isModerator),
            }),
            final(State.Allowed),
          ),
        );

        const result = yield* simulate(machine, [Event.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("Guard.not negates a guard", async () => {
    const isGuest = Guard.make<IdleState, AccessEvent>(({ state }) => state.role === "guest");

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ role: "user", age: 20 })),
            on(State.Idle, Event.Access, () => State.Allowed(), {
              guard: Guard.not(isGuest),
            }),
            final(State.Allowed),
          ),
        );

        const result = yield* simulate(machine, [Event.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });

  test("Guard.for auto-narrows types from constructors", async () => {
    // Guard.for infers types from constructors - no manual type annotations needed
    const isAdmin = Guard.for(State.Idle, Event.Access)(({ state }) => state.role === "admin");
    const isAdult = Guard.for(State.Idle, Event.Access)(({ state }) => state.age >= 18);

    await Effect.runPromise(
      Effect.gen(function* () {
        const machine = build(
          pipe(
            make<State, Event>(State.Idle({ role: "admin", age: 25 })),
            on(State.Idle, Event.Access, () => State.Allowed(), {
              guard: Guard.and(isAdmin, isAdult),
            }),
            final(State.Allowed),
          ),
        );

        const result = yield* simulate(machine, [Event.Access()]);
        expect(result.finalState._tag).toBe("Allowed");
      }),
    );
  });
});
