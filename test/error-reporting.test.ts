// @effect-diagnostics strictEffectProvide:off - tests are entry points
// @effect-diagnostics anyUnknownInErrorContext:off
import { Cause, Data, Effect, ErrorReporter, Layer, References, type Scope } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  ActorSystemDefault,
  Event,
  Machine,
  State,
  Supervision,
  type ActorExit,
  type DefectPhase,
} from "../src/index.js";

// ============================================================================
// Fixtures
// ============================================================================

/** A defect with object identity. Equal messages must still report separately. */
class LifecycleDefect extends Data.TaggedError(
  "effect-machine/test/error-reporting.test/LifecycleDefect",
)<{ readonly message: string }> {}

const S = State({ Idle: {}, Active: {}, Done: {} });
const E = Event({ Start: {}, Crash: {}, Finish: {} });

interface Report {
  readonly cause: Cause.Cause<unknown>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/** A raw reporter. It records every call, so it can prove the absence of duplicate reports. */
const makeRecorder = () => {
  const reports: Report[] = [];
  const reporter: ErrorReporter.ErrorReporter = {
    [ErrorReporter.TypeId]: ErrorReporter.TypeId,
    report: ({ cause, fiber }) => {
      reports.push({ cause, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    },
  };
  return { reporter, reports, layer: ErrorReporter.layer([reporter]) };
};

const onlyReport = (reports: ReadonlyArray<Report>): Effect.Effect<Report> => {
  expect(reports).toHaveLength(1);
  const [report] = reports;
  if (report === undefined) return Effect.die("expected one report");
  return Effect.succeed(report);
};

const defectsOf = (cause: Cause.Cause<unknown>): ReadonlyArray<unknown> =>
  cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect);

/** Poll a condition that another fiber settles. */
const eventually = (predicate: () => boolean) =>
  Effect.sleep("1 millis").pipe(
    Effect.repeat({ until: predicate }),
    Effect.timeout("1 second"),
    Effect.orDie,
  );

const annotationsFor = (actorId: string, generation: number, phase: string) => ({
  "effect_machine.actor.id": actorId,
  "effect_machine.actor.generation": generation,
  "effect_machine.defect.phase": phase,
});

interface PhaseCase {
  readonly name: string;
  readonly actorId: string;
  readonly phase: DefectPhase;
  /** Spawns an actor, makes it fail with `failure`, and returns its terminal exit. */
  readonly run: (
    failure: LifecycleDefect,
  ) => Effect.Effect<ActorExit<unknown, unknown>, never, Scope.Scope>;
}

const phaseCases: ReadonlyArray<PhaseCase> = [
  {
    name: "a transition defect",
    actorId: "transition",
    phase: "transition",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle }).on(
          S.Idle,
          E.Crash,
          () => Effect.die(failure),
        );
        const actor = yield* Machine.spawn(machine, { id: "transition" });
        yield* actor.start;
        yield* actor.send(E.Crash);
        return yield* actor.awaitExit;
      }),
  },
  {
    name: "an initial spawn defect",
    actorId: "initial-spawn",
    phase: "initial-spawn",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Idle, () =>
          Effect.die(failure),
        );
        const actor = yield* Machine.spawn(machine, { id: "initial-spawn" });
        yield* Effect.exit(actor.start);
        return yield* actor.awaitExit;
      }),
  },
  {
    name: "a spawn effect defect",
    actorId: "spawn",
    phase: "spawn",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle })
          .on(S.Idle, E.Start, () => S.Active)
          .spawn(S.Active, () => Effect.yieldNow.pipe(Effect.andThen(Effect.die(failure))));
        const actor = yield* Machine.spawn(machine, { id: "spawn" });
        yield* actor.start;
        yield* actor.send(E.Start);
        return yield* actor.awaitExit;
      }),
  },
  {
    name: "a task defect",
    actorId: "task",
    phase: "spawn",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle })
          .on(S.Idle, E.Start, () => S.Active)
          .on(S.Active, E.Finish, () => S.Done)
          .task(S.Active, () => Effect.die(failure), { onSuccess: () => E.Finish })
          .final(S.Done);
        const actor = yield* Machine.spawn(machine, { id: "task" });
        yield* actor.start;
        yield* actor.send(E.Start);
        return yield* actor.awaitExit;
      }),
  },
  {
    name: "a background defect",
    actorId: "background",
    phase: "background",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle }).background(() =>
          Effect.yieldNow.pipe(Effect.andThen(Effect.die(failure))),
        );
        const actor = yield* Machine.spawn(machine, { id: "background" });
        yield* actor.start;
        return yield* actor.awaitExit;
      }),
  },
  {
    name: "a cleanup defect during stop",
    actorId: "cleanup",
    phase: "cleanup",
    run: (failure) =>
      Effect.gen(function* () {
        const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Idle, () =>
          Effect.addFinalizer(() => Effect.die(failure)),
        );
        const actor = yield* Machine.spawn(machine, { id: "cleanup" });
        yield* actor.start;
        yield* Effect.exit(actor.stop);
        return yield* actor.awaitExit;
      }),
  },
];

// ============================================================================
// Generation closure
// ============================================================================

describe("error reporting: generation closure", () => {
  for (const phaseCase of phaseCases) {
    it.scopedLive(`reports ${phaseCase.name} once with the settled cause`, () =>
      Effect.gen(function* () {
        const recorder = makeRecorder();
        const failure = new LifecycleDefect({ message: phaseCase.name });
        const exit = yield* phaseCase.run(failure).pipe(Effect.provide(recorder.layer));

        expect(exit._tag).toBe("Defect");
        if (exit._tag !== "Defect") return;
        expect(exit.phase).toBe(phaseCase.phase);
        const report = yield* onlyReport(recorder.reports);
        expect(report.cause).toBe(exit.cause);
        expect(defectsOf(report.cause)).toContain(failure);
        expect(report.annotations).toMatchObject(
          annotationsFor(phaseCase.actorId, 0, phaseCase.phase),
        );
      }),
    );
  }

  it.scopedLive("reports a transition defect and a cleanup defect in one aggregate", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const transitionFailure = new LifecycleDefect({ message: "same message" });
      const cleanupFailure = new LifecycleDefect({ message: "same message" });
      const machine = Machine.make({ state: S, event: E, initial: S.Idle })
        .spawn(S.Idle, () => Effect.addFinalizer(() => Effect.die(cleanupFailure)))
        .on(S.Idle, E.Crash, () => Effect.die(transitionFailure));
      const exit = yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine, { id: "aggregate" });
        yield* actor.start;
        yield* actor.send(E.Crash);
        return yield* actor.awaitExit;
      }).pipe(Effect.provide(recorder.layer));

      expect(exit._tag).toBe("Defect");
      if (exit._tag !== "Defect") return;
      expect(exit.phase).toBe("cleanup");
      const report = yield* onlyReport(recorder.reports);
      expect(report.cause).toBe(exit.cause);
      const defects = defectsOf(report.cause);
      expect(defects).toHaveLength(2);
      expect(defects[0]).toBe(transitionFailure);
      expect(defects[1]).toBe(cleanupFailure);
      expect(report.annotations).toMatchObject(annotationsFor("aggregate", 0, "cleanup"));
    }),
  );

  it.scopedLive("keeps equal-message failures distinct in a native reporter", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const reporter = ErrorReporter.make(({ error }) => {
        messages.push(error.message);
      });
      const machine = Machine.make({ state: S, event: E, initial: S.Idle })
        .spawn(S.Idle, () =>
          Effect.addFinalizer(() => Effect.die(new LifecycleDefect({ message: "same message" }))),
        )
        .on(S.Idle, E.Crash, () => Effect.die(new LifecycleDefect({ message: "same message" })));
      yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        yield* actor.send(E.Crash);
        yield* actor.awaitExit;
      }).pipe(Effect.provide(ErrorReporter.layer([reporter])));

      expect(messages).toEqual(["same message", "same message"]);
    }),
  );

  it.scopedLive("does not report a failure twice when the start caller also reports it", () =>
    Effect.gen(function* () {
      const messages: string[] = [];
      const reporter = ErrorReporter.make(({ error }) => {
        messages.push(error.message);
      });
      const failure = new LifecycleDefect({ message: "initial spawn failure" });
      const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Idle, () =>
        Effect.die(failure),
      );
      const started = yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        return yield* actor.start.pipe(Effect.withErrorReporting, Effect.exit);
      }).pipe(Effect.provide(ErrorReporter.layer([reporter])));

      expect(started._tag).toBe("Failure");
      expect(messages).toEqual(["initial spawn failure"]);
    }),
  );

  it.scopedLive("does not report normal stops, final states, or interruption", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const machine = Machine.make({ state: S, event: E, initial: S.Idle })
        .on(S.Idle, E.Finish, () => S.Done)
        .spawn(S.Idle, () => Effect.never)
        .background(() => Effect.never)
        .final(S.Done);
      const exits = yield* Effect.gen(function* () {
        const stopped = yield* Machine.spawn(machine);
        yield* stopped.start;
        yield* stopped.stop;
        const finished = yield* Machine.spawn(machine);
        yield* finished.start;
        yield* finished.send(E.Finish);
        return [yield* stopped.awaitExit, yield* finished.awaitExit];
      }).pipe(Effect.provide(recorder.layer));

      expect(exits.map((exit) => exit._tag)).toEqual(["Stopped", "Final"]);
      expect(recorder.reports).toHaveLength(0);
    }),
  );
});

// ============================================================================
// Captured spawn context and restarts
// ============================================================================

describe("error reporting: captured spawn context", () => {
  it.scopedLive("reports every restarted generation to the reporters captured at spawn", () =>
    Effect.gen(function* () {
      const spawnRecorder = makeRecorder();
      const callerRecorder = makeRecorder();
      const failures: LifecycleDefect[] = [];
      const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Idle, () =>
        Effect.suspend(() => {
          const failure = new LifecycleDefect({ message: `generation ${failures.length}` });
          failures.push(failure);
          return Effect.die(failure);
        }),
      );
      const actor = yield* Machine.spawn(machine, {
        id: "restarting",
        supervision: Supervision.restart({ maxRestarts: 2 }),
      }).pipe(Effect.provide(spawnRecorder.layer));
      const exit = yield* Effect.gen(function* () {
        yield* actor.start;
        return yield* actor.awaitExit;
      }).pipe(Effect.provide(callerRecorder.layer));

      expect(exit._tag).toBe("Defect");
      expect(failures).toHaveLength(3);
      expect(callerRecorder.reports).toHaveLength(0);
      expect(spawnRecorder.reports).toHaveLength(3);
      spawnRecorder.reports.forEach((report, generation) => {
        const defects = defectsOf(report.cause);
        expect(defects).toHaveLength(1);
        expect(defects[0]).toBe(failures[generation]);
        expect(report.annotations).toMatchObject(
          annotationsFor("restarting", generation, "initial-spawn"),
        );
      });
    }),
  );

  it.scopedLive("does not borrow a caller's reporters when none were captured at spawn", () =>
    Effect.gen(function* () {
      const callerRecorder = makeRecorder();
      const machine = Machine.make({ state: S, event: E, initial: S.Idle }).spawn(S.Idle, () =>
        Effect.die(new LifecycleDefect({ message: "initial spawn" })),
      );
      const actor = yield* Machine.spawn(machine, {
        supervision: Supervision.restart({ maxRestarts: 1 }),
      });
      const exit = yield* Effect.gen(function* () {
        yield* actor.start;
        return yield* actor.awaitExit;
      }).pipe(Effect.provide(callerRecorder.layer));

      expect(exit._tag).toBe("Defect");
      expect(callerRecorder.reports).toHaveLength(0);
    }),
  );

  it.scopedLive("reports a child failure to the reporters captured by its parent", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const failure = new LifecycleDefect({ message: "child transition" });
      const child = Machine.make({ state: S, event: E, initial: S.Idle }).on(S.Idle, E.Crash, () =>
        Effect.die(failure),
      );
      const parent = Machine.make({ state: S, event: E, initial: S.Idle }).background(({ self }) =>
        self.spawn("child", child).pipe(
          Effect.orDie,
          Effect.flatMap((ref) => ref.send(E.Crash).pipe(Effect.andThen(ref.awaitExit))),
          Effect.andThen(Effect.never),
        ),
      );
      const exit = yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(parent, { id: "parent" });
        yield* actor.start;
        yield* eventually(() => actor.children.has("child"));
        const childRef = actor.children.get("child");
        if (childRef === undefined) return yield* Effect.die("child was not spawned");
        const childExit = yield* childRef.awaitExit;
        yield* actor.stop;
        return childExit;
      }).pipe(Effect.provide(Layer.merge(recorder.layer, ActorSystemDefault)));

      expect(exit._tag).toBe("Defect");
      const report = yield* onlyReport(recorder.reports);
      expect(defectsOf(report.cause)).toEqual([failure]);
      expect(report.annotations).toMatchObject(annotationsFor("child", 0, "transition"));
    }),
  );
});

// ============================================================================
// Actor-owned failures
// ============================================================================

describe("error reporting: actor-owned failures", () => {
  it.scopedLive("reports a final output defect once at terminal completion", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const failure = new LifecycleDefect({ message: "output" });
      const machine = Machine.make({ state: S, event: E, initial: S.Idle })
        .on(S.Idle, E.Finish, () => S.Done)
        .final(S.Done, () => {
          // oxlint-disable-next-line effect/noThrowStatement -- final output callbacks are synchronous; this throw is the defect under test.
          throw failure;
        });
      const exit = yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine, { id: "output" });
        yield* actor.start;
        yield* actor.send(E.Finish);
        return yield* actor.awaitExit;
      }).pipe(Effect.provide(recorder.layer));

      expect(exit._tag).toBe("Defect");
      if (exit._tag !== "Defect") return;
      const report = yield* onlyReport(recorder.reports);
      expect(report.cause).toBe(exit.cause);
      expect(defectsOf(exit.cause)).toEqual([failure]);
      expect(report.annotations).toMatchObject(annotationsFor("output", 0, "cleanup"));
    }),
  );

  it.scopedLive("reports a restart failure that leaves no generation to close", () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const transitionFailure = new LifecycleDefect({ message: "transition" });
      const recoveryFailure = new LifecycleDefect({ message: "recovery" });
      const machine = Machine.make({ state: S, event: E, initial: S.Idle }).on(
        S.Idle,
        E.Crash,
        () => Effect.die(transitionFailure),
      );
      yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine, {
          id: "recovery",
          supervision: Supervision.restart({ maxRestarts: 1 }),
          lifecycle: {
            recovery: {
              resolve: ({ generation }) => {
                if (generation === 0) return Effect.succeedNone;
                return Effect.die(recoveryFailure);
              },
            },
          },
        });
        yield* actor.start;
        yield* actor.send(E.Crash);
        yield* eventually(() => recorder.reports.length >= 2);
        yield* Effect.exit(actor.stop);
      }).pipe(Effect.provide(recorder.layer));

      expect(recorder.reports.map((report) => defectsOf(report.cause))).toEqual([
        [transitionFailure],
        [recoveryFailure],
      ]);
      expect(recorder.reports.at(1)?.annotations).toMatchObject(
        annotationsFor("recovery", 1, "restart"),
      );
    }),
  );

  it.scopedLive("settles the actor when a reporter throws", () =>
    Effect.gen(function* () {
      const throwing: ErrorReporter.ErrorReporter = {
        [ErrorReporter.TypeId]: ErrorReporter.TypeId,
        report: () => {
          // oxlint-disable-next-line effect/noThrowStatement -- a host reporter can throw; this throw is the fault under test.
          throw new LifecycleDefect({ message: "reporter bug" });
        },
      };
      const machine = Machine.make({ state: S, event: E, initial: S.Idle }).on(
        S.Idle,
        E.Crash,
        () => Effect.die(new LifecycleDefect({ message: "transition" })),
      );
      const exit = yield* Effect.gen(function* () {
        const actor = yield* Machine.spawn(machine);
        yield* actor.start;
        yield* actor.send(E.Crash);
        return yield* actor.awaitExit.pipe(Effect.timeout("1 second"));
      }).pipe(Effect.provide(ErrorReporter.layer([throwing])));

      expect(exit._tag).toBe("Defect");
    }),
  );
});
