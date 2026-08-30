// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Context, Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  ActorSystemDefault,
  ActorSystemService,
  collectingInspector,
  Event,
  InspectorService,
  Machine,
  State,
  type AnyInspectionEvent,
} from "../src/index.js";

class Audit extends Context.Service<
  Audit,
  { readonly record: (value: string) => Effect.Effect<void> }
>()("effect-machine/test/transition-effects.test/Audit") {}

const TestState = State({ Idle: {}, Done: {} });
const TestEvent = Event({ Go: {} });

describe("Effectful transitions", () => {
  it.scopedLive("runs Effects in order before the state becomes visible", () => {
    const records: string[] = [];
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Idle,
    }).on(TestState.Idle, TestEvent.Go, () =>
      Effect.gen(function* () {
        const audit = yield* Audit;
        yield* audit.record("first");
        yield* audit.record("second");
        return TestState.Done;
      }),
    );

    return Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("transition-order", machine);
      actor.subscribe(() => records.push("visible"));
      yield* actor.send(TestEvent.Go);
      yield* Effect.yieldNow;
      expect(records).toEqual(["first", "second", "visible"]);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(Audit, {
        record: (value) => Effect.sync(() => void records.push(value)),
      }),
    );
  });

  it.scopedLive("reports a transition defect and stops the actor", () => {
    const events: AnyInspectionEvent[] = [];
    const machine = Machine.make({
      state: TestState,
      event: TestEvent,
      initial: TestState.Idle,
    }).on(TestState.Idle, TestEvent.Go, () => Effect.die("boom").pipe(Effect.as(TestState.Done)));

    return Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine);
      yield* actor.start;
      yield* actor.send(TestEvent.Go);
      expect((yield* actor.awaitExit)._tag).toBe("Defect");
      expect(
        events.some((event) => event.type === "@machine.error" && event.phase === "transition"),
      ).toBe(true);
    }).pipe(
      Effect.provide(ActorSystemDefault),
      Effect.provideService(InspectorService, collectingInspector(events)),
    );
  });

  it.scopedLive("settles actor exit when an initial Effect defects", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: TestState,
        event: TestEvent,
        initial: TestState.Idle,
      }).immediate(TestState.Idle, () => Effect.die("boom").pipe(Effect.as(TestState.Done)));
      const actor = yield* Machine.spawn(machine);

      expect((yield* Effect.exit(actor.start))._tag).toBe("Failure");
      expect((yield* actor.awaitExit)._tag).toBe("Defect");
      yield* Effect.yieldNow;
      expect(actor.sync.lifecycle()._tag).toBe("Defect");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
});
