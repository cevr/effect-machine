# Testing

Testing patterns for effect-machine.

## Testing Approaches

| Approach            | Use When                                    |
| ------------------- | ------------------------------------------- |
| `simulate`          | Testing state transitions (no side effects) |
| `createTestHarness` | Step-by-step state inspection               |
| `assertReaches`     | Quick assertions on final state             |
| Actor testing       | Testing with real effects, delays           |

## simulate

Run a sequence of events and get all intermediate states.

```typescript
import { Effect } from "effect";
import { simulate } from "effect-machine";

test("transitions through states", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* simulate(machine, [
        Event.Fetch({ url: "/api" }),
        Event.Resolve({ data: "hello" }),
      ]);

      // All states visited
      expect(result.states.map((s) => s._tag)).toEqual(["Idle", "Loading", "Success"]);

      // Final state
      expect(result.finalState._tag).toBe("Success");
      if (result.finalState._tag === "Success") {
        expect(result.finalState.data).toBe("hello");
      }
    }),
  );
});
```

**Characteristics:**

- Pure - no side effects executed
- No actor system needed
- Includes `always` transitions
- Stops at final states

## createTestHarness

Step-by-step testing with state inspection between events.

```typescript
import { createTestHarness } from "effect-machine";

test("step-by-step testing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const harness = yield* createTestHarness(machine);

      // Check initial state
      let state = yield* harness.getState;
      expect(state._tag).toBe("Idle");

      // Send event
      yield* harness.send(Event.Fetch({ url: "/api" }));

      // Check intermediate state
      state = yield* harness.getState;
      expect(state._tag).toBe("Loading");

      // Continue...
      yield* harness.send(Event.Resolve({ data: "ok" }));
      state = yield* harness.getState;
      expect(state._tag).toBe("Success");
    }),
  );
});
```

**Characteristics:**

- Pure - no side effects
- Inspect state between events
- Good for complex flows

## assertReaches

Quick assertion that events lead to expected state.

```typescript
import { assertReaches } from "effect-machine";

test("fetch succeeds", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* assertReaches(
        machine,
        [Event.Fetch({ url: "/api" }), Event.Resolve({ data: "ok" })],
        "Success",
      );
    }),
  );
});

test("fetch fails", async () => {
  const result = await Effect.runPromise(
    assertReaches(
      machine,
      [Event.Fetch({ url: "/api" })],
      "Success", // Won't reach
    ).pipe(Effect.either),
  );

  expect(result._tag).toBe("Left"); // Assertion failed
});
```

## Actor Testing

For testing with real effects (entry/exit, delays).

```typescript
import { Effect, Layer, TestClock, TestContext } from "effect";
import { ActorSystemDefault, ActorSystemService, yieldFibers } from "effect-machine";

test("actor with effects", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Send event
      yield* actor.send(Event.Start());

      // Let effects run
      yield* yieldFibers;

      // Check state
      const state = yield* actor.state.get;
      expect(state._tag).toBe("Running");
    }).pipe(Effect.scoped, Effect.provide(ActorSystemDefault)),
  );
});
```

### Testing Delays with TestClock

```typescript
test("auto-dismiss after delay", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("notification", machine);

      // Initial state
      let state = yield* actor.state.get;
      expect(state._tag).toBe("Showing");

      // Advance time
      yield* TestClock.adjust("3 seconds");
      yield* yieldFibers;

      // Should have auto-dismissed
      state = yield* actor.state.get;
      expect(state._tag).toBe("Dismissed");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(ActorSystemDefault, TestContext.TestContext)),
    ),
  );
});
```

**Key:** Use `Layer.merge` to provide both ActorSystem and TestContext.

## yieldFibers

Let background fibers execute:

```typescript
import { yieldFibers } from "effect-machine";

// After sending event that triggers async effect
yield * actor.send(Event.Start());
yield * yieldFibers; // Effects run here
const state = yield * actor.state.get;
```

## Testing Guards

Test guards in isolation:

```typescript
const isAdmin = Guard.make<UserState, AccessEvent>(({ state }) => state.role === "admin");

test("isAdmin guard", () => {
  const adminCtx = {
    state: State.User({ role: "admin" }),
    event: Event.Access(),
  };
  const userCtx = {
    state: State.User({ role: "user" }),
    event: Event.Access(),
  };

  expect(isAdmin(adminCtx)).toBe(true);
  expect(isAdmin(userCtx)).toBe(false);
});
```

## Testing always Transitions

`simulate` includes always transitions:

```typescript
test("always transitions fire immediately", async () => {
  const machine = build(
    pipe(
      make<State, Event>(State.Calculating({ value: 75 })),
      always(State.Calculating, [
        { guard: (s) => s.value >= 70, to: () => State.High() },
        { otherwise: true, to: () => State.Low() },
      ]),
      final(State.High),
      final(State.Low),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      // No events needed - always fires on initial state
      const result = yield* simulate(machine, []);
      expect(result.finalState._tag).toBe("High");
    }),
  );
});
```

## Testing choose

```typescript
test("choose cascade - first match wins", async () => {
  const machine = build(
    pipe(
      make<State, Event>(State.Input({ value: 50 })),
      choose(State.Input, Event.Classify, [
        { guard: ({ state }) => state.value >= 70, to: () => State.High() },
        { guard: ({ state }) => state.value >= 40, to: () => State.Medium() },
        { otherwise: true, to: () => State.Low() },
      ]),
      final(State.High),
      final(State.Medium),
      final(State.Low),
    ),
  );

  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* simulate(machine, [Event.Classify()]);
      expect(result.finalState._tag).toBe("Medium"); // 50 >= 40
    }),
  );
});
```

## See Also

- `actors.md` - actor system details
- `combinators.md` - all combinators
- `guards.md` - guard composition
