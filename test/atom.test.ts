import { Effect, Schema } from "effect";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import { expect, it } from "effect-bun-test";

import * as ActorAtom from "../src/atom.js";
import { Machine } from "../src/index.js";
import { Event, State } from "../src/schema.js";

const CounterState = State({
  Active: { count: Schema.Finite, label: Schema.String },
});

const CounterEvent = Event({
  Increment: {},
  Rename: { label: Schema.String },
});

const counterMachine = Machine.make({
  state: CounterState,
  event: CounterEvent,
  initial: CounterState.Active({ count: 0, label: "Counter" }),
})
  .on(CounterState.Active, CounterEvent.Increment, ({ state }) =>
    CounterState.Active.with(state, { count: state.count + 1 }),
  )
  .on(CounterState.Active, CounterEvent.Rename, ({ state, event }) =>
    CounterState.Active.with(state, { label: event.label }),
  );

it.scopedLive("make exposes actor state and sends events through Atom writes", () =>
  Effect.gen(function* () {
    const actor = yield* Machine.spawn(counterMachine);
    yield* actor.start;

    const registry = AtomRegistry.make();
    const stateAtom = ActorAtom.make(actor);
    const values: Array<number> = [];
    const unsubscribe = registry.subscribe(stateAtom, (state) => values.push(state.count), {
      immediate: true,
    });

    registry.set(stateAtom, CounterEvent.Increment);
    yield* actor.waitFor((state) => state.count === 1);
    yield* Effect.yieldNow;

    expect(registry.get(stateAtom).count).toBe(1);
    expect(values).toEqual([0, 1]);

    unsubscribe();
    registry.dispose();
    yield* actor.stop;
  }),
);

it.scopedLive("select only publishes changes to the selected value", () =>
  Effect.gen(function* () {
    const actor = yield* Machine.spawn(counterMachine);
    yield* actor.start;

    const registry = AtomRegistry.make();
    const stateAtom = ActorAtom.make(actor);
    const countAtom = ActorAtom.select(stateAtom, (state) => state.count);
    const values: Array<number> = [];
    const unsubscribe = registry.subscribe(countAtom, (count) => values.push(count), {
      immediate: true,
    });

    registry.set(countAtom, CounterEvent.Rename({ label: "New name" }));
    yield* actor.waitFor((state) => state.label === "New name");
    yield* Effect.yieldNow;
    registry.set(countAtom, CounterEvent.Increment);
    yield* actor.waitFor((state) => state.count === 1);
    yield* Effect.yieldNow;

    expect(registry.get(countAtom)).toBe(1);
    expect(values).toEqual([0, 1]);

    unsubscribe();
    registry.dispose();
    yield* actor.stop;
  }),
);

it.scopedLive("select supports a custom equality function", () =>
  Effect.gen(function* () {
    const actor = yield* Machine.spawn(counterMachine);
    yield* actor.start;

    const registry = AtomRegistry.make();
    const parityAtom = ActorAtom.make(actor).pipe(
      ActorAtom.select(
        (state) => ({ even: state.count % 2 === 0 }),
        (value, next) => value.even === next.even,
      ),
    );
    const values: Array<boolean> = [];
    const unsubscribe = registry.subscribe(parityAtom, (parity) => values.push(parity.even), {
      immediate: true,
    });

    registry.set(parityAtom, CounterEvent.Rename({ label: "Same parity" }));
    yield* actor.waitFor((state) => state.label === "Same parity");
    yield* Effect.yieldNow;
    registry.set(parityAtom, CounterEvent.Increment);
    yield* actor.waitFor((state) => state.count === 1);
    yield* Effect.yieldNow;

    expect(values).toEqual([true, false]);

    unsubscribe();
    registry.dispose();
    yield* actor.stop;
  }),
);

it.scopedLive("lifecycle and latest transition atoms retain terminal values", () =>
  Effect.gen(function* () {
    const FinalState = State({ Idle: {}, Done: {} });
    const FinalEvent = Event({ Finish: {} });
    const finalMachine = Machine.make({
      state: FinalState,
      event: FinalEvent,
      initial: FinalState.Idle,
    })
      .on(FinalState.Idle, FinalEvent.Finish, () => FinalState.Done)
      .final(FinalState.Done);
    const actor = yield* Machine.spawn(finalMachine);
    yield* actor.start;

    const registry = AtomRegistry.make();
    const lifecycleAtom = ActorAtom.lifecycle(actor);
    const transitionAtom = ActorAtom.latestTransition(actor);
    yield* actor.send(FinalEvent.Finish);
    yield* actor.awaitExit;
    yield* Effect.yieldNow;

    expect(registry.get(lifecycleAtom)._tag).toBe("Final");
    expect(registry.get(transitionAtom)?.event._tag).toBe("Finish");
    expect(registry.get(transitionAtom)?.toState._tag).toBe("Done");

    registry.dispose();
  }),
);

it.scopedLive("can reevaluates guarded transitions when actor state changes", () =>
  Effect.gen(function* () {
    const LimitedState = State({ Active: { count: Schema.Finite } });
    const LimitedEvent = Event({ Increment: {} });
    const limitedMachine = Machine.make({
      state: LimitedState,
      event: LimitedEvent,
      initial: LimitedState.Active({ count: 0 }),
    }).when(
      LimitedState.Active,
      LimitedEvent.Increment,
      ({ state }) => state.count < 1,
      ({ state }) => LimitedState.Active({ count: state.count + 1 }),
    );
    const actor = yield* Machine.spawn(limitedMachine);
    yield* actor.start;

    const registry = AtomRegistry.make();
    const canIncrementAtom = ActorAtom.can(actor, LimitedEvent.Increment);

    expect(yield* AtomRegistry.getResult(registry, canIncrementAtom)).toBe(true);
    yield* actor.call(LimitedEvent.Increment);
    expect(yield* AtomRegistry.getResult(registry, canIncrementAtom)).toBe(false);

    registry.dispose();
    yield* actor.stop;
  }),
);
