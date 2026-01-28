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
import { simulate, Machine, State, Event } from "effect-machine";

test("transitions through states", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* simulate(machine, [
        MyEvent.Fetch({ url: "/api" }),
        MyEvent.Resolve({ data: "hello" }),
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
      yield* harness.send(MyEvent.Fetch({ url: "/api" }));

      // Check intermediate state
      state = yield* harness.getState;
      expect(state._tag).toBe("Loading");

      // Continue...
      yield* harness.send(MyEvent.Resolve({ data: "ok" }));
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
        [MyEvent.Fetch({ url: "/api" }), MyEvent.Resolve({ data: "ok" })],
        "Success",
      );
    }),
  );
});

test("fetch fails", async () => {
  const result = await Effect.runPromise(
    assertReaches(
      machine,
      [MyEvent.Fetch({ url: "/api" })],
      "Success", // Won't reach
    ).pipe(Effect.either),
  );

  expect(result._tag).toBe("Left"); // Assertion failed
});
```

## Actor Testing

For testing with real effects (spawn, delays).

```typescript
import { Effect, Layer, TestClock, TestContext } from "effect";
import { ActorSystemDefault, ActorSystemService } from "effect-machine";

test("actor with effects", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);
      yield* Effect.yieldNow(); // Let spawn effect run

      // Send event
      yield* actor.send(MyEvent.Start);
      yield* Effect.yieldNow(); // Let async effects run

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
      yield* Effect.yieldNow();

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

## Yielding to Effects

Use `Effect.yieldNow()` to let background fibers execute:

```typescript
// After sending event that triggers async effect
yield * actor.send(MyEvent.Start);
yield * Effect.yieldNow(); // Effects run here
const state = yield * actor.state.get;
```

## Testing Guards

Test guards via machine transitions:

```typescript
test("guard blocks transition", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const machine = Machine.make({
        state: MyState,
        event: MyEvent,
        guards: MyGuards,
        initial: MyState.Form({ retries: 5 }),
      })
        .on(MyState.Form, MyEvent.Submit, ({ state, guards }) =>
          Effect.gen(function* () {
            if (yield* guards.canRetry({ max: 3 })) {
              return MyState.Submitting;
            }
            return state;
          }),
        )
        .provide({
          canRetry: ({ max }, { state }) => state.retries < max,
        });

      const result = yield* simulate(machine, [MyEvent.Submit]);
      expect(result.finalState._tag).toBe("Form"); // Blocked - retries >= max
    }),
  );
});
```

## Testing choose

```typescript
test("choose cascade - first match wins", async () => {
  const MyState = State({
    Input: { value: Schema.Number },
    High: {},
    Medium: {},
    Low: {},
  });
  type MyState = typeof MyState.Type;

  const MyEvent = Event({ Classify: {} });
  type MyEvent = typeof MyEvent.Type;

  const machine = Machine.make({
    state: MyState,
    event: MyEvent,
    initial: MyState.Input({ value: 50 }),
  })
    .choose(MyState.Input, MyEvent.Classify, [
      { guard: ({ state }) => state.value >= 70, to: () => MyState.High },
      { guard: ({ state }) => state.value >= 40, to: () => MyState.Medium },
      { to: () => MyState.Low }, // Fallback
    ])
    .final(MyState.High)
    .final(MyState.Medium)
    .final(MyState.Low);

  await Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* simulate(machine, [MyEvent.Classify]);
      expect(result.finalState._tag).toBe("Medium"); // 50 >= 40
    }),
  );
});
```

## See Also

- `actors.md` - actor system details
- `combinators.md` - all combinators
- `guards.md` - guard composition
