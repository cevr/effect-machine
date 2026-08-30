// @effect-diagnostics missingEffectContext:off
// @effect-diagnostics missingEffectError:off
// @effect-diagnostics unnecessaryEffectGen:off
// @effect-diagnostics deterministicKeys:off
/**
 * Type-level tests for handler constraints.
 *
 * These tests verify that handlers:
 * 1. Can require arbitrary services in Effectful transition handlers
 * 2. Cannot produce errors
 * 3. Must return machine-scoped state schema
 *
 * All "bad" tests use @ts-expect-error on the handler return expression.
 */
import { Effect, Schema, Context } from "effect";
import {
  ActorSystemDefault,
  ActorSystemService,
  Machine,
  State,
  Event,
  simulate,
} from "../src/index.js";

const MyState = State({
  Idle: {},
  Loading: { url: Schema.String },
  Done: {},
});

const MyEvent = Event({
  Start: {},
  Complete: {},
});

// Test 1: Effectful transition handlers can require arbitrary services
class MyService extends Context.Service<MyService, { foo: string }>()("@test/MyService") {}

const _test1 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
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
class MyError extends Schema.TaggedError<MyError>()("MyError", {}) {}

const _test3 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
  // @ts-expect-error - Handler cannot produce errors (MyError not assignable to never)
}).on(MyState.Idle, MyEvent.Start, () =>
  Effect.gen(function* () {
    return yield* MyError.make({});
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

// Test 5: spawn handler can require arbitrary services
const _test5 = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
})
  .on(MyState.Idle, MyEvent.Start, () => MyState.Loading({ url: "/" }))
  .spawn(MyState.Loading, () => MyService);

// ============================================================================
// Reply Schema Type Constraints
// ============================================================================

const ReplyEvent = Event({
  GetCount: Event.reply({}, Schema.Finite),
  GetName: Event.reply({}, Schema.String),
  Fire: {},
});

// Test 3b: Every Effectful transition builder rejects typed errors
const transitionFailure = Effect.fail(MyError.make({}));

Machine.make({ state: MyState, event: MyEvent, initial: MyState.Idle })
  // @ts-expect-error - reenter Effect error must be never
  .reenter(MyState.Idle, MyEvent.Start, () => transitionFailure)
  // @ts-expect-error - onAny Effect error must be never
  .onAny(MyEvent.Complete, () => transitionFailure)
  // @ts-expect-error - immediate Effect error must be never
  .immediate(MyState.Idle, () => transitionFailure);

Machine.make({ state: MyState, event: MyEvent, initial: MyState.Idle }).from(
  MyState.Idle,
  (scope) =>
    scope.on(
      MyEvent.Start,
      // @ts-expect-error - scoped transition Effect error must be never
      () => transitionFailure,
    ),
);

// Test 3c: Every Effectful transition builder records service requirements
const transitionWithService = Effect.map(MyService, () => MyState.Done);
const _test3c = Machine.make({ state: MyState, event: MyEvent, initial: MyState.Idle })
  .reenter(MyState.Idle, MyEvent.Start, () => transitionWithService)
  .onAny(MyEvent.Complete, () => transitionWithService)
  .immediate(MyState.Idle, () => transitionWithService)
  .from(MyState.Idle, (scope) => scope.on(MyEvent.Start, () => transitionWithService));

// Test 3d: A machine cannot spawn until all transition requirements are provided
const _test3d = () => {
  // @ts-expect-error - MyService is still required
  Effect.runPromise(Machine.spawn(_test3c));
  Effect.runPromise(
    Machine.spawn(_test3c).pipe(Effect.provideService(MyService, { foo: "ready" })),
  );

  const systemSpawn = Effect.gen(function* () {
    const system = yield* ActorSystemService;
    return yield* system.spawn("requires-service", _test3c);
  });
  // @ts-expect-error - ActorSystemDefault does not provide MyService
  Effect.runPromise(systemSpawn.pipe(Effect.provide(ActorSystemDefault)));
  Effect.runPromise(
    systemSpawn.pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(MyService, { foo: "ready" }),
    ),
  );
};

// Test 3e: Machine input is required at every spawn seam
const inputMachine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: (input: { readonly url: string }) => MyState.Loading(input),
});

const _test3e = () => {
  // @ts-expect-error - input machine requires input
  const missingInput = Machine.spawn(inputMachine);
  const hasInput = Machine.spawn(inputMachine, { input: { url: "/ready" } });
  // @ts-expect-error - simulation requires input
  const missingSimulationInput = simulate(inputMachine, []);
  const simulation = simulate(inputMachine, [], { input: { url: "/ready" } });
  // @ts-expect-error - replay requires input or a starting snapshot
  const missingReplayInput = Machine.replay(inputMachine, []);
  const replay = Machine.replay(inputMachine, [], { input: { url: "/ready" } });

  const systemSpawn = Effect.gen(function* () {
    const system = yield* ActorSystemService;
    // @ts-expect-error - system spawn also requires input
    yield* system.spawn("missing-input", inputMachine);
    yield* system.spawn("has-input", inputMachine, { input: { url: "/ready" } });
  });
  return {
    missingInput,
    hasInput,
    missingSimulationInput,
    simulation,
    missingReplayInput,
    replay,
    systemSpawn,
  };
};

// Test 3f: Final output is inferred independently from final state
const outputMachine = Machine.make({
  state: MyState,
  event: MyEvent,
  initial: MyState.Idle,
}).final(MyState.Loading, ({ state }) => ({ requestedUrl: state.url }));

const _test3f = Effect.gen(function* () {
  const actor = yield* Machine.spawn(outputMachine);
  const output: { readonly requestedUrl: string } = yield* actor.awaitOutput;
  return output;
});

const ReplyState = State({
  Active: { count: Schema.Finite },
  Done: {},
});

// Test 6: Handler for reply-bearing event MUST return Machine.reply()
const _test6 = Machine.make({
  state: ReplyState,
  event: ReplyEvent,
  initial: ReplyState.Active({ count: 0 }),
}).on(ReplyState.Active, ReplyEvent.GetCount, ({ state }) =>
  Machine.reply(ReplyState.Active({ count: state.count }), state.count),
);

// Test 7: Handler for reply-bearing event CANNOT return plain state
const _test7 = Machine.make({
  state: ReplyState,
  event: ReplyEvent,
  initial: ReplyState.Active({ count: 0 }),
  // @ts-expect-error - reply-bearing event requires Machine.reply(), not plain state
}).on(ReplyState.Active, ReplyEvent.GetCount, () => ReplyState.Active({ count: 0 }));

// Test 8: Handler for non-reply event CANNOT return Machine.reply()
const _test8 = Machine.make({
  state: ReplyState,
  event: ReplyEvent,
  initial: ReplyState.Active({ count: 0 }),
  // @ts-expect-error - non-reply event handler cannot return Machine.reply()
}).on(ReplyState.Active, ReplyEvent.Fire, () => Machine.reply(ReplyState.Done, 42));

// Test 9: Machine.reply() type must match schema
const _test9 = Machine.make({
  state: ReplyState,
  event: ReplyEvent,
  initial: ReplyState.Active({ count: 0 }),
  // @ts-expect-error - reply type string doesn't match Schema.Number
}).on(ReplyState.Active, ReplyEvent.GetCount, ({ state }) =>
  Machine.reply(ReplyState.Active({ count: state.count }), "not a number"),
);

// Test 9b: reply-bearing constructors accept plain payload fields, not hidden reply metadata
const PayloadReplyEvent = Event({
  GetById: Event.reply({ id: Schema.String }, Schema.Finite),
});
const _test9bPayload: Parameters<typeof PayloadReplyEvent.GetById>[0] = { id: "task-1" };
const _test9b = PayloadReplyEvent.GetById(_test9bPayload);
const _test9bId: string = _test9b.id;

// This file should compile with all @ts-expect-error comments being valid
