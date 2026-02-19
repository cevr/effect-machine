// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics missingEffectError:off
// @effect-diagnostics unnecessaryEffectGen:off
// @effect-diagnostics deterministicKeys:off
/**
 * Type-level tests for handler constraints.
 *
 * These tests verify that handlers:
 * 1. Cannot require arbitrary services (only Scope for spawn/background)
 * 2. Cannot produce errors
 * 3. Must return machine-scoped state schema
 *
 * All "bad" tests use @ts-expect-error on the handler return expression.
 */
import { Effect, Schema, ServiceMap } from "effect";
import { Machine, State, Event } from "../src/index.js";

const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Done: {},
});

const MyEvent = Event({
  Start: {},
  Complete: {},
});

// Test 1: Handler cannot require arbitrary services
class MyService extends ServiceMap.Service<MyService, { foo: string }>()("@test/MyService") {}

const _test1 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
  // @ts-expect-error - Handler cannot require arbitrary services (MyService not in R=never)
}).on(MyState.Idle, MyEvent.Start, () =>
  Effect.gen(function* () {
    const svc = yield* MyService;
    return MyState.Loading({ url: svc.foo });
  }),
);

// Test 2: Handler cannot return wrong state
const WrongState = State({
  Other: {},
});

const _test2 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
  // @ts-expect-error - Handler must return state from machine's schema
}).on(MyState.Idle, MyEvent.Start, () => WrongState.Other);

// Test 3: Handler cannot produce errors
class MyError extends Schema.TaggedErrorClass<MyError>()("MyError", {}) {}

const _test3 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
  // @ts-expect-error - Handler cannot produce errors (MyError not assignable to never)
}).on(MyState.Idle, MyEvent.Start, () =>
  Effect.gen(function* () {
    return yield* new MyError({});
  }),
);

// Test 4: spawn handler CAN use Scope (for finalizers) - should compile
const _test4 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, () => MyState.Loading({ url: "/" }))
  .spawn(MyState.Loading, () => Effect.addFinalizer(() => Effect.log("cleanup")));

// Test 5: spawn handler cannot require arbitrary services
const _test5 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, () => MyState.Loading({ url: "/" }))
  // @ts-expect-error - spawn handler cannot require arbitrary services (MyService not Scope)
  .spawn(MyState.Loading, () => MyService);

// This file should compile with all @ts-expect-error comments being valid
export {};
