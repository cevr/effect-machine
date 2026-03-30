// @effect-diagnostics strictEffectProvide:off - tests are entry points
/**
 * Local Persistence Tests
 *
 * Verifies Machine.spawn({ persist }) behavior:
 * - load() hydrates initial state
 * - save() called on each state change
 * - shouldSave() filters saves
 * - supervision restart re-loads from persistence
 * - hydrate overrides persist.load()
 */
import { Duration, Effect, Option, Ref, Schema } from "effect";
import { Machine, State, Event } from "../src/index.js";
import { Supervision } from "../src/supervision.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test/v3";

const PState = State({
  Idle: {},
  Active: { count: Schema.Number },
  Done: {},
});

const PEvent = Event({
  Activate: { count: Schema.Number },
  Increment: {},
  Finish: {},
});

const machine = Machine.make({
  state: PState,
  event: PEvent,
  initial: PState.Idle,
})
  .on(PState.Idle, PEvent.Activate, ({ event }) => PState.Active({ count: event.count }))
  .on(PState.Active, PEvent.Increment, ({ state }) => PState.Active({ count: state.count + 1 }))
  .on(PState.Active, PEvent.Finish, () => PState.Done)
  .final(PState.Done);

describe("Machine.spawn with persist", () => {
  it.scopedLive("load() hydrates initial state", () =>
    Effect.gen(function* () {
      const savedState = PState.Active({ count: 42 });
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.some(savedState)),
          save: () => Effect.void,
        },
      });

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
      expect((state as { count: number }).count).toBe(42);
      yield* actor.stop;
    }),
  );

  it.scopedLive("load() returning None uses machine.initial", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.none()),
          save: () => Effect.void,
        },
      });

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Idle");
      yield* actor.stop;
    }),
  );

  it.scopedLive("save() called on each state change", () =>
    Effect.gen(function* () {
      const saves = yield* Ref.make<Array<{ _tag: string }>>([]);
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.none()),
          save: (state) => Ref.update(saves, (arr) => [...arr, { _tag: state._tag }]),
        },
      });

      yield* actor.send(PEvent.Activate({ count: 1 }));
      yield* yieldFibers;
      yield* actor.send(PEvent.Increment);
      yield* yieldFibers;
      yield* actor.send(PEvent.Finish);
      yield* yieldFibers;

      const savedStates = yield* Ref.get(saves);
      expect(savedStates).toEqual([{ _tag: "Active" }, { _tag: "Active" }, { _tag: "Done" }]);
      yield* actor.stop;
    }),
  );

  it.scopedLive("shouldSave() filters saves", () =>
    Effect.gen(function* () {
      const saves = yield* Ref.make<Array<string>>([]);
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.none()),
          save: (state) => Ref.update(saves, (arr) => [...arr, state._tag]),
          // Only save when state tag changes
          shouldSave: (state, prev) => state._tag !== prev._tag,
        },
      });

      yield* actor.send(PEvent.Activate({ count: 1 }));
      yield* yieldFibers;
      // Same-tag transition (Active -> Active) — should NOT save
      yield* actor.send(PEvent.Increment);
      yield* yieldFibers;
      yield* actor.send(PEvent.Increment);
      yield* yieldFibers;
      yield* actor.send(PEvent.Finish);
      yield* yieldFibers;

      const savedTags = yield* Ref.get(saves);
      // Only Idle->Active and Active->Done, not Active->Active
      expect(savedTags).toEqual(["Active", "Done"]);
      yield* actor.stop;
    }),
  );

  it.scopedLive("hydrate overrides persist.load()", () =>
    Effect.gen(function* () {
      let loadCalled = false;
      const actor = yield* Machine.spawn(machine, {
        hydrate: PState.Active({ count: 99 }),
        persist: {
          load: () => {
            loadCalled = true;
            return Effect.succeed(Option.some(PState.Active({ count: 1 })));
          },
          save: () => Effect.void,
        },
      });

      const state = yield* actor.snapshot;
      // hydrate wins — count is 99, not 1
      expect((state as { count: number }).count).toBe(99);
      // load was never called because hydrate takes precedence
      expect(loadCalled).toBe(false);
      yield* actor.stop;
    }),
  );

  it.scopedLive("supervision restart re-loads from persistence", () =>
    Effect.gen(function* () {
      const CrashState = State({
        Idle: {},
        Active: { count: Schema.Number },
      });
      const CrashEvent = Event({
        Activate: { count: Schema.Number },
        Crash: {},
      });

      const crashMachine = Machine.make({
        state: CrashState,
        event: CrashEvent,
        initial: CrashState.Idle,
      })
        .on(CrashState.Idle, CrashEvent.Activate, ({ event }) =>
          CrashState.Active({ count: event.count }),
        )
        .on(CrashState.Active, CrashEvent.Crash, () => Effect.die("boom"));

      const storage = yield* Ref.make<Option.Option<typeof CrashState.Type>>(Option.none());
      const loadCountRef = yield* Ref.make(0);

      const actor = yield* Machine.spawn(crashMachine, {
        supervision: Supervision.restart({ maxRestarts: 2 }),
        persist: {
          load: () => Ref.update(loadCountRef, (n) => n + 1).pipe(Effect.andThen(Ref.get(storage))),
          save: (state) => Ref.set(storage, Option.some(state)),
        },
      });

      // Transition to Active — triggers save
      yield* actor.send(CrashEvent.Activate({ count: 10 }));
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(50));

      const stateBeforeCrash = yield* actor.snapshot;
      expect(stateBeforeCrash._tag).toBe("Active");

      // This will crash (defect) → supervision restarts → re-loads from persistence
      yield* actor.send(CrashEvent.Crash);
      yield* Effect.yieldNow();
      yield* yieldFibers;
      yield* Effect.sleep(Duration.millis(100));
      yield* yieldFibers;

      // After restart, should have re-loaded the saved Active(10) state
      const stateAfterRestart = yield* actor.snapshot;
      expect(stateAfterRestart._tag).toBe("Active");
      expect((stateAfterRestart as { count: number }).count).toBe(10);

      // load was called: once at spawn + once on restart
      const loadCount = yield* Ref.get(loadCountRef);
      expect(loadCount).toBe(2);

      yield* actor.stop;
    }),
  );
});

describe("Machine.spawn with persist.onRestore", () => {
  it.scopedLive("onRestore transforms loaded state", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.some(PState.Active({ count: 100 }))),
          save: () => Effect.void,
          // Cap count at 50 on restore
          onRestore: (state) =>
            Effect.succeed(
              state._tag === "Active" && (state as { count: number }).count > 50
                ? Option.some(PState.Active({ count: 50 }))
                : Option.some(state),
            ),
        },
      });

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Active");
      expect((state as { count: number }).count).toBe(50);
      yield* actor.stop;
    }),
  );

  it.scopedLive("onRestore returning None falls back to machine.initial", () =>
    Effect.gen(function* () {
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.some(PState.Active({ count: 999 }))),
          save: () => Effect.void,
          // Reject persisted state — start fresh
          onRestore: () => Effect.succeed(Option.none()),
        },
      });

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Idle");
      yield* actor.stop;
    }),
  );

  it.scopedLive("onRestore not called when load returns None", () =>
    Effect.gen(function* () {
      let onRestoreCalled = false;
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.none()),
          save: () => Effect.void,
          onRestore: () => {
            onRestoreCalled = true;
            return Effect.succeed(Option.none());
          },
        },
      });

      const state = yield* actor.snapshot;
      expect(state._tag).toBe("Idle");
      expect(onRestoreCalled).toBe(false);
      yield* actor.stop;
    }),
  );

  it.scopedLive("onRestore receives initial state in context", () =>
    Effect.gen(function* () {
      let receivedInitial: unknown = undefined;
      const actor = yield* Machine.spawn(machine, {
        persist: {
          load: () => Effect.succeed(Option.some(PState.Active({ count: 1 }))),
          save: () => Effect.void,
          onRestore: (state, ctx) => {
            receivedInitial = ctx.initial;
            return Effect.succeed(Option.some(state));
          },
        },
      });

      expect((receivedInitial as { _tag: string })._tag).toBe("Idle");
      yield* actor.stop;
    }),
  );

  it.scopedLive("hydrate bypasses onRestore entirely", () =>
    Effect.gen(function* () {
      let loadCalled = false;
      let onRestoreCalled = false;
      const actor = yield* Machine.spawn(machine, {
        hydrate: PState.Active({ count: 77 }),
        persist: {
          load: () => {
            loadCalled = true;
            return Effect.succeed(Option.some(PState.Active({ count: 1 })));
          },
          save: () => Effect.void,
          onRestore: () => {
            onRestoreCalled = true;
            return Effect.succeed(Option.none());
          },
        },
      });

      const state = yield* actor.snapshot;
      expect((state as { count: number }).count).toBe(77);
      expect(loadCalled).toBe(false);
      expect(onRestoreCalled).toBe(false);
      yield* actor.stop;
    }),
  );
});
