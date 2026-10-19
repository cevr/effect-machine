// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Scheduler } from "effect";
import type { Semaphore } from "effect";
import { describe, expect, it } from "effect-bun-test";

import type { ActorStoppedError } from "../src/index.js";
import { ActorSystemDefault, Event, Machine, State, Supervision } from "../src/index.js";
import { trackRegistrations } from "./wait-registrations.js";

// Property: a wait observes every state written from the moment it subscribes, in write order,
// each once, and succeeds with the first one that matches. `sendAndWait` subscribes before it
// sends. A predicate call never starts inside another one. A wait whose match is written ends
// while the actor still runs, and a wait without a match does no work while no state is
// written. A settled wait holds no listener, terminal wake-up or subscription.
//
// Domain: the wait starts at any point of the actor's life: before `start`, during the startup
// and recovery writes, while it runs, between a write and its notification, inside a
// notification, before a stop, and across a supervised restart. The run ends with a final
// state, with a stop, or not at all: a live scenario is judged while the actor still runs, and
// only then stopped.
//
// Oracle: the harness records every write of the actor's state ref, its own notifications, and
// the moment the wait under test first observes the state (it reads the ref or subscribes to the
// ref's publication). The actor never reads this log. The expected states are the state held at
// that moment and every later write; the expected calls and outcome come from a fresh copy of
// the predicate replayed over them. Nothing in the oracle comes from the wait's result or calls.

const OrderState = State({ Idle: {}, Ready: {}, Working: {}, Other: {}, Done: {} });
type OrderState = typeof OrderState.Type;
type Tag = OrderState["_tag"];
// No state handles Stay: sending it writes nothing.
const OrderEvent = Event({ Work: {}, Next: {}, Ping: {}, Finish: {}, Stay: {} });
type OrderEvent = typeof OrderEvent.Type;
type EventTag = OrderEvent["_tag"];
const eventOf: { readonly [E in EventTag]: OrderEvent } = {
  Work: OrderEvent.Work,
  Next: OrderEvent.Next,
  Ping: OrderEvent.Ping,
  Finish: OrderEvent.Finish,
  Stay: OrderEvent.Stay,
};

// Builder methods mutate the machine, so each scenario builds its own.
const makeMachine = () =>
  Machine.make({ state: OrderState, event: OrderEvent, initial: OrderState.Idle })
    .on(OrderState.Idle, OrderEvent.Work, () => OrderState.Working)
    .on(OrderState.Working, OrderEvent.Next, () => OrderState.Other)
    // Empty variants are singletons, so Ping writes the very object that Work wrote.
    .on(OrderState.Working, OrderEvent.Ping, () => OrderState.Working)
    .on(
      [OrderState.Idle, OrderState.Ready, OrderState.Working, OrderState.Other],
      OrderEvent.Finish,
      () => OrderState.Done,
    )
    .final(OrderState.Done);
type OrderMachine = ReturnType<typeof makeMachine>;
const spawnOrder = (machine: OrderMachine) => Machine.spawn(machine);
type OrderActor = Effect.Success<ReturnType<typeof spawnOrder>>;

/** `start` moves Idle to Ready, and Work leaves Ready. */
const makeStartupMachine = () =>
  makeMachine()
    .immediate(OrderState.Idle, () => OrderState.Ready)
    .on(OrderState.Ready, OrderEvent.Work, () => OrderState.Working);

/** `start` recovers Working before the machine runs. */
const spawnRecovering = (machine: OrderMachine) =>
  Machine.spawn(machine, {
    lifecycle: { recovery: { resolve: () => Effect.succeedSome(OrderState.Working) } },
  });

/** The first entry of Working dies; the actor restarts once. */
const spawnRestarting = (build: (machine: OrderMachine) => OrderMachine) =>
  Effect.suspend(() => {
    let entries = 0;
    const machine = build(makeMachine()).spawn(OrderState.Working, () => {
      entries += 1;
      if (entries === 1) return Effect.die("first entry crashes");
      return Effect.void;
    });
    return Machine.spawn(machine, { supervision: Supervision.restart({ maxRestarts: 1 }) });
  });

interface Scenario {
  readonly name: string;
  /** A fresh actor, not started. */
  readonly spawn: Effect.Effect<OrderActor>;
  /** Events sent once with no handshake. A form that sends sends the last one itself. */
  readonly sends: readonly [EventTag, ...Array<EventTag>];
  /** An event sent from the harness listener at the first notification of a state. */
  readonly gate?: { readonly event: EventTag; readonly afterNotify: Tag };
  /** Every write after `record`, in a run where no predicate sends. Checked in each such run. */
  readonly writes: ReadonlyArray<Tag>;
  /** Every notification of the harness listener in such a run, in order. */
  readonly notifies: ReadonlyArray<Tag>;
  /** How many of `writes` (and notifications) `actor.start` causes. */
  readonly startupWrites: number;
  /** How many of the startup writes recover a state. Nothing runs between such a write and its notification. */
  readonly recoveryWrites: number;
  /** How many of `writes` (and notifications) come before the last event's writes. */
  readonly prefixWrites: number;
  /** A supervised restart writes state outside the event loop's write-then-notify order. */
  readonly restarts: boolean;
  /** The actor never terminates by itself: the harness judges the wait, then stops it. */
  readonly live: boolean;
  /** Each event writes once and no entry effect writes, so a stop can overtake one write. */
  readonly stoppable: boolean;
}

type ScenarioOptions = Partial<
  Pick<Scenario, "startupWrites" | "recoveryWrites" | "live" | "stoppable">
>;

const plain = (
  name: string,
  spawn: Effect.Effect<OrderActor>,
  sends: readonly [EventTag, ...Array<EventTag>],
  writes: ReadonlyArray<Tag>,
  prefixWrites: number,
  options: ScenarioOptions = {},
): Scenario => ({
  name,
  spawn,
  sends,
  writes,
  notifies: writes,
  startupWrites: 0,
  recoveryWrites: 0,
  prefixWrites,
  restarts: false,
  live: false,
  stoppable: true,
  ...options,
});

const sentShort = plain(
  "test sends Work,Finish",
  spawnOrder(makeMachine()),
  ["Work", "Finish"],
  ["Working", "Done"],
  1,
);
const sentLong = plain(
  "test sends Work,Next,Finish",
  spawnOrder(makeMachine()),
  ["Work", "Next", "Finish"],
  ["Working", "Other", "Done"],
  2,
);
const finishOnly = plain("test sends Finish", spawnOrder(makeMachine()), ["Finish"], ["Done"], 0);
const brief = plain(
  "Working sends Finish",
  spawnOrder(makeMachine().spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Finish))),
  ["Work"],
  ["Working", "Done"],
  0,
  { stoppable: false },
);
const chain = plain(
  "Working sends Next, Other sends Finish",
  spawnOrder(
    makeMachine()
      .spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Next))
      .spawn(OrderState.Other, ({ self }) => self.send(OrderEvent.Finish)),
  ),
  ["Work"],
  ["Working", "Other", "Done"],
  0,
  { stoppable: false },
);
const ping = plain(
  "test sends Work,Ping,Finish (Ping rewrites the same object)",
  spawnOrder(makeMachine()),
  ["Work", "Ping", "Finish"],
  ["Working", "Working", "Done"],
  2,
);
const startupShort = plain(
  "start moves Idle to Ready, test sends Work,Finish",
  spawnOrder(makeStartupMachine()),
  ["Work", "Finish"],
  ["Ready", "Working", "Done"],
  2,
  { startupWrites: 1 },
);
const recoverImmediate = plain(
  "start recovers Working and moves it to Other, test sends Finish",
  spawnRecovering(makeMachine().immediate(OrderState.Working, () => OrderState.Other)),
  ["Finish"],
  ["Working", "Other", "Done"],
  2,
  { startupWrites: 2, recoveryWrites: 1 },
);

// Live scenarios: no final state, so only a state notification can end a matching wait.
const liveWork = plain(
  "test sends Work, stays live",
  spawnOrder(makeMachine()),
  ["Work"],
  ["Working"],
  0,
  { live: true },
);
const liveWorkNext = plain(
  "test sends Work,Next, stays live",
  spawnOrder(makeMachine()),
  ["Work", "Next"],
  ["Working", "Other"],
  1,
  { live: true },
);
const liveBrief = plain(
  "Working sends Next, stays live",
  spawnOrder(makeMachine().spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Next))),
  ["Work"],
  ["Working", "Other"],
  0,
  { live: true, stoppable: false },
);
const livePing = plain(
  "test sends Work,Ping, stays live (Ping rewrites the same object)",
  spawnOrder(makeMachine()),
  ["Work", "Ping"],
  ["Working", "Working"],
  1,
  { live: true },
);
const startupLive = plain(
  "start moves Idle to Ready, test sends Work, stays live",
  spawnOrder(makeStartupMachine()),
  ["Work"],
  ["Ready", "Working"],
  1,
  { startupWrites: 1, live: true },
);
const recoverLive = plain(
  "start recovers Working, stays live",
  spawnRecovering(makeMachine()),
  ["Stay"],
  ["Working"],
  1,
  { startupWrites: 1, recoveryWrites: 1, live: true, stoppable: false },
);
const recoverImmediateLive = plain(
  "start recovers Working and moves it to Other, stays live",
  spawnRecovering(makeMachine().immediate(OrderState.Working, () => OrderState.Other)),
  ["Stay"],
  ["Working", "Other"],
  2,
  { startupWrites: 2, recoveryWrites: 1, live: true, stoppable: false },
);

const restartCrashMachine = (machine: OrderMachine) => machine;
const restartStaleMachine = (machine: OrderMachine) =>
  machine
    .immediate(OrderState.Idle, () => OrderState.Ready)
    .on(OrderState.Ready, OrderEvent.Work, () => OrderState.Working);
// r2 N3: Working is written, its entry crashes before the notification, and the restart
// writes Idle over it.
const restartCrash: Scenario = {
  name: "Working's entry crashes, the actor restarts",
  spawn: spawnRestarting(restartCrashMachine),
  sends: ["Work"],
  gate: { event: "Finish", afterNotify: "Idle" },
  writes: ["Working", "Idle", "Done"],
  notifies: ["Idle", "Done"],
  startupWrites: 0,
  recoveryWrites: 0,
  prefixWrites: 0,
  restarts: true,
  live: false,
  stoppable: false,
};
// r2 N2: the restart writes Idle, the new generation writes and notifies Ready, then the restart
// notifies Idle.
const restartStale: Scenario = {
  name: "Ready's Working entry crashes, the restart notifies late",
  spawn: spawnRestarting(restartStaleMachine),
  sends: ["Work"],
  gate: { event: "Finish", afterNotify: "Idle" },
  writes: ["Ready", "Working", "Idle", "Ready", "Done"],
  notifies: ["Ready", "Ready", "Idle", "Done"],
  startupWrites: 1,
  recoveryWrites: 0,
  prefixWrites: 1,
  restarts: true,
  live: false,
  stoppable: false,
};
const restartCrashLive: Scenario = {
  ...restartCrash,
  name: "Working's entry crashes, the actor restarts and stays live",
  spawn: spawnRestarting(restartCrashMachine),
  gate: undefined,
  writes: ["Working", "Idle"],
  notifies: ["Idle"],
  live: true,
};
const restartStaleLive: Scenario = {
  ...restartStale,
  name: "Ready's Working entry crashes, the restart notifies late and stays live",
  spawn: spawnRestarting(restartStaleMachine),
  gate: undefined,
  writes: ["Ready", "Working", "Idle", "Ready"],
  notifies: ["Ready", "Ready", "Idle"],
  live: true,
};

const terminalScenarios = [
  sentShort,
  sentLong,
  finishOnly,
  brief,
  chain,
  ping,
  startupShort,
  recoverImmediate,
];
const liveScenarios = [
  liveWork,
  liveWorkNext,
  liveBrief,
  livePing,
  startupLive,
  recoverLive,
  recoverImmediateLive,
];
const restartScenarios = [restartCrash, restartStale, restartCrashLive, restartStaleLive];
const allScenarios = [...terminalScenarios, ...liveScenarios, ...restartScenarios];
// A form that sends starts with no other writer: its own event comes last and alone.
const alone = (scenarios: ReadonlyArray<Scenario>) =>
  scenarios.filter(({ sends }) => sends.length === 1);

interface PredicateCase {
  readonly name: string;
  /** The predicate sends events to the actor while it judges. */
  readonly sends: boolean;
  /** A fresh predicate per run, because some predicates keep state. */
  readonly make: (send: (event: EventTag) => void) => (state: OrderState) => boolean;
}

const is = (tag: Tag): PredicateCase => ({
  name: tag,
  sends: false,
  make: () => (state) => state._tag === tag,
});
const oneOf = (first: Tag, second: Tag): PredicateCase => ({
  name: `${first} or ${second}`,
  sends: false,
  make: () => (state) => state._tag === first || state._tag === second,
});
const never: PredicateCase = { name: "never", sends: false, make: () => () => false };
const nthCall = (n: number): PredicateCase => ({
  name: `call ${n}`,
  sends: false,
  make: () => {
    let calls = 0;
    return () => {
      calls += 1;
      return calls === n;
    };
  },
});
const after = (seen: Tag, target: Tag): PredicateCase => ({
  name: `${target} after ${seen}`,
  sends: false,
  make: () => {
    let sawEarlier = false;
    return (state) => {
      if (state._tag === seen) sawEarlier = true;
      return sawEarlier && state._tag === target;
    };
  },
});
/** Sends `event` once, while it judges the first state with tag `on`. */
const sendsOn = (on: Tag, event: EventTag, accept: PredicateCase): PredicateCase => ({
  name: `sends ${event} on ${on}, accepts ${accept.name}`,
  sends: true,
  make: (send) => {
    const judge = accept.make(send);
    let sent = false;
    return (state) => {
      if (state._tag === on && !sent) {
        sent = true;
        send(event);
      }
      return judge(state);
    };
  },
});
const every: PredicateCase = { name: "every state", sends: false, make: () => () => true };

const predicateCases: ReadonlyArray<PredicateCase> = [
  is("Idle"),
  is("Working"),
  is("Other"),
  is("Done"),
  oneOf("Idle", "Working"),
  oneOf("Working", "Other"),
  never,
  nthCall(1),
  nthCall(2),
  nthCall(3),
  nthCall(4),
  after("Idle", "Working"),
  after("Working", "Other"),
  after("Idle", "Done"),
  after("Working", "Done"),
  sendsOn("Idle", "Work", every),
  sendsOn("Working", "Next", oneOf("Other", "Done")),
  sendsOn("Idle", "Work", nthCall(2)),
];

interface Form {
  readonly name: string;
  /** The form sends the scenario's last event itself; its observation must start before. */
  readonly sendsItself: boolean;
  /** `awaitFinal` and `sendAndWait(event)` take no predicate: only their result is visible. */
  readonly takesPredicate: boolean;
  readonly wait: (
    actor: OrderActor,
    event: OrderEvent,
    predicate: (state: OrderState) => boolean,
  ) => Effect.Effect<OrderState, ActorStoppedError>;
}

const waitForForm: Form = {
  name: "waitFor",
  sendsItself: false,
  takesPredicate: true,
  wait: (actor, _event, predicate) => actor.waitFor(predicate),
};
const awaitFinalForm: Form = {
  name: "awaitFinal",
  sendsItself: false,
  takesPredicate: false,
  wait: (actor) => actor.awaitFinal,
};
const sendAndWaitForm: Form = {
  name: "sendAndWait",
  sendsItself: true,
  takesPredicate: true,
  wait: (actor, event, predicate) => actor.sendAndWait(event, predicate),
};
const sendAndWaitFinalForm: Form = {
  name: "sendAndWait final",
  sendsItself: true,
  takesPredicate: false,
  wait: (actor, event) => actor.sendAndWait(event),
};
const forms = [waitForForm, awaitFinalForm, sendAndWaitForm, sendAndWaitFinalForm];

// ---------------------------------------------------------------------------
// The write log
// ---------------------------------------------------------------------------

type Entry =
  | { readonly kind: "write"; readonly tag: Tag }
  | {
      readonly kind: "notify";
      readonly phase: "begin" | "end";
      readonly index: number;
      readonly tag: Tag;
    }
  | { readonly kind: "call" }
  | { readonly kind: "start" }
  /** `actor.start` returned. */
  | { readonly kind: "started" };

/** Marks the fibers of the wait under test, so the log can tell its observation apart. */
const UnderTest = Context.Reference<boolean>("effect-machine/test/wait-order/UnderTest", {
  defaultValue: () => false,
});
const inWaitUnderTest = (): boolean => Fiber.getCurrent()?.getRef(UnderTest) === true;

interface Recorder {
  readonly log: Array<Entry>;
  readonly writes: () => number;
  readonly notifications: () => number;
  /** Runs synchronously right after the wait's first observation of the state. */
  onStart: () => void;
  /** Runs inside write `index`, before it is published: it must not touch the actor. */
  onWrite: (index: number) => void;
  /** Runs at the start of the harness's own notification `index`. */
  onNotify: (index: number, tag: Tag) => void;
}

/**
 * Instrument the actor's state ref before it starts. The accessor sees every write, because
 * `SubscriptionRef` stores the value in this field, and it sees reads. The publication's
 * `replayWindow` runs once per subscription, right after it registers.
 */
const record = (actor: OrderActor, scenario: Scenario): Recorder => {
  const recorder: Recorder = {
    log: [],
    writes: () => recorder.log.filter(({ kind }) => kind === "write").length - 1,
    notifications: () =>
      recorder.log.filter((entry) => entry.kind === "notify" && entry.phase === "begin").length,
    onStart: () => undefined,
    onWrite: () => undefined,
    onNotify: () => undefined,
  };
  const ref = actor.state;
  let value = ref.value;
  recorder.log.push({ kind: "write", tag: value._tag });
  let started = false;
  const observe = (): void => {
    if (started || !inWaitUnderTest()) return;
    started = true;
    recorder.log.push({ kind: "start" });
    recorder.onStart();
  };
  Object.defineProperty(ref, "value", {
    configurable: true,
    enumerable: true,
    get: () => {
      const current = value;
      observe();
      return current;
    },
    set: (next: OrderState) => {
      value = next;
      recorder.log.push({ kind: "write", tag: next._tag });
      recorder.onWrite(recorder.writes());
    },
  });
  const atomic = ref.pubsub.pubsub;
  const replayWindow = atomic.replayWindow.bind(atomic);
  atomic.replayWindow = () => {
    const window = replayWindow();
    observe();
    return window;
  };
  let gateOpen = scenario.gate !== undefined;
  let notifications = 0;
  actor.subscribe((state) => {
    notifications += 1;
    const index = notifications;
    recorder.log.push({ kind: "notify", phase: "begin", index, tag: state._tag });
    if (gateOpen && scenario.gate?.afterNotify === state._tag) {
      gateOpen = false;
      actor.client.send(eventOf[scenario.gate.event]);
    }
    recorder.onNotify(index, state._tag);
    // A listener added during a notification runs last in that notification.
    const unsubscribe = actor.subscribe(() => {
      recorder.log.push({ kind: "notify", phase: "end", index, tag: state._tag });
      unsubscribe();
    });
  });
  return recorder;
};

/** Index of the first entry matching `match`, or -1. */
const indexOf = (log: ReadonlyArray<Entry>, match: (entry: Entry) => boolean): number =>
  log.findIndex(match);
const isNotifyBegin = (entry: Entry): boolean => entry.kind === "notify" && entry.phase === "begin";
const writesIn = (entries: ReadonlyArray<Entry>): ReadonlyArray<Tag> =>
  entries.flatMap((entry) => {
    if (entry.kind === "write") return [entry.tag];
    return [];
  });
const notifiesIn = (entries: ReadonlyArray<Entry>): ReadonlyArray<Tag> =>
  entries.flatMap((entry) => {
    if (entry.kind === "notify" && entry.phase === "begin") return [entry.tag];
    return [];
  });
const notifyAt = (log: ReadonlyArray<Entry>, phase: "begin" | "end", index: number): number =>
  indexOf(
    log,
    (entry) => entry.kind === "notify" && entry.phase === phase && entry.index === index,
  );
/** Index of write `k` (the state held at `record` is write 0), or -1. */
const writeAt = (log: ReadonlyArray<Entry>, k: number): number => {
  let writes = -1;
  return indexOf(log, (entry) => {
    if (entry.kind === "write") writes += 1;
    return entry.kind === "write" && writes === k;
  });
};

// ---------------------------------------------------------------------------
// Start points
// ---------------------------------------------------------------------------

interface RunContext {
  readonly actor: OrderActor;
  readonly scenario: Scenario;
  readonly recorder: Recorder;
  readonly form: Form;
  /** `actor.start`, then the log notes that it returned. A start point that owns it runs it. */
  readonly startActor: Effect.Effect<void>;
  /** The wait under test, marked, logging its call first. */
  readonly wait: Effect.Effect<Exit.Exit<OrderState, ActorStoppedError>>;
  /** Count the operations of a wait that runs outside the run's fiber tree. */
  readonly counted: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  /** Wait until neither the log nor the wait moves; false when they keep moving. */
  readonly quiet: Effect.Effect<boolean>;
  /** Events the harness sends: all of them, or all but the form's own last one. */
  readonly driverSends: ReadonlyArray<EventTag>;
  /** Runs synchronously after the predicate's first call returns. */
  afterFirstCall: () => void;
}

interface Start {
  readonly family: string;
  readonly value: number | string;
  /** The start point stops the actor itself. */
  readonly stops: boolean;
  /** The drive runs `actor.start` itself; otherwise the run starts the actor before it. */
  readonly ownsStart: boolean;
  readonly drive: (
    context: RunContext,
  ) => Effect.Effect<Fiber.Fiber<Exit.Exit<OrderState, ActorStoppedError>>>;
  /** Whether the run reached the window this start point names. */
  readonly reached: (log: ReadonlyArray<Entry>) => boolean;
}

/** The events the harness sends: all of them, or all but the form's own last one. */
const driverSendsOf = (form: Form, scenario: Scenario): ReadonlyArray<EventTag> =>
  scenario.sends.slice(0, scenario.sends.length - Number(form.sendsItself));

const sendAll = (actor: OrderActor, events: ReadonlyArray<EventTag>): void => {
  for (const event of events) actor.client.send(eventOf[event]);
};
const signal = (deferred: Deferred.Deferred<void>): void => {
  Deferred.doneUnsafe(deferred, Exit.void);
};
// Synchronous steps inside the recorder's hooks, where no fiber can be suspended.
const holdPermit = (permit: Semaphore.Semaphore): void => {
  Effect.runSync(permit.take(1));
};
const startNow = <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> => Effect.runFork(effect);

const startIndex = (log: ReadonlyArray<Entry>): number =>
  indexOf(log, (entry) => entry.kind === "start");
const startedIndex = (log: ReadonlyArray<Entry>): number =>
  indexOf(log, (entry) => entry.kind === "started");
/** The wait starts before every write after the actor started. */
const startsFirst = (log: ReadonlyArray<Entry>): boolean => {
  const start = startIndex(log);
  const started = startedIndex(log);
  return start > started && writesIn(log.slice(started, start)).length === 0;
};
/** The wait starts before `start` returns and before the first write. */
const startsBeforeStart = (log: ReadonlyArray<Entry>): boolean => {
  const start = startIndex(log);
  const started = startedIndex(log);
  return start !== -1 && (started === -1 || start < started) && writeAt(log, 1) > start;
};

interface Schedule {
  readonly family: "budget" | "yield at";
  readonly value: number;
  readonly apply: <A, E>(wait: Effect.Effect<A, E>) => Effect.Effect<A, E>;
}

/** Budget 2 livelocks a fiber in the Effect scheduler, so the budgets start at 3. */
const budget = (operations: number): Schedule => ({
  family: "budget",
  value: operations,
  apply: (wait) => Effect.provideService(wait, Scheduler.MaxOpsBeforeYield, operations),
});

/**
 * The default scheduler, except that the wait yields once, `offset` operations in. It still
 * asks `base`, so the run's operation count sees the wait.
 */
const yieldAt = (offset: number): Schedule => ({
  family: "yield at",
  value: offset,
  apply: (wait) =>
    Effect.flatMap(Effect.service(Scheduler.Scheduler), (base) => {
      let operations = 0;
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        shouldYield: (fiber) => {
          base.shouldYield(fiber);
          operations += 1;
          return operations === offset + 1;
        },
        makeDispatcher: () => base.makeDispatcher(),
      };
      return Effect.provideService(wait, Scheduler.Scheduler, scheduler);
    }),
});

const schedules: ReadonlyArray<Schedule> = [
  ...Array.from({ length: 62 }, (_, index) => budget(index + 3)),
  ...Array.from({ length: 161 }, (_, index) => yieldAt(index)),
];

/**
 * Provide a scheduler that counts each operation of the wait under test's fibers, then defers
 * to the current one. It wraps the whole run, so it adds no operation inside the wait.
 */
const countingWaitOperations =
  (count: () => void) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.service(Scheduler.Scheduler), (base) => {
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        shouldYield: (fiber) => {
          if (fiber.getRef(UnderTest)) count();
          return base.shouldYield(fiber);
        },
        makeDispatcher: () => base.makeDispatcher(),
      };
      return Effect.provideService(effect, Scheduler.Scheduler, scheduler);
    });

/**
 * r3's start points: the wait runs at once until the schedule makes it yield, and the writes
 * are sent right after that, with no handshake. A send runs the actor's loop in the sender's
 * call, so a wait that only starts later would see every write already done.
 */
const race = (schedule: Schedule): Start => ({
  family: schedule.family,
  value: schedule.value,
  stops: false,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      const waiting = yield* context.wait.pipe(
        schedule.apply,
        Effect.forkDetach({ startImmediately: true }),
      );
      sendAll(context.actor, context.driverSends);
      return waiting;
    }),
  reached: () => true,
});

/** The wait runs at once until the schedule makes it yield, and `start` runs right after. */
const raceStart = (schedule: Schedule): Start => ({
  family: `${schedule.family}, then start`,
  value: schedule.value,
  stops: false,
  ownsStart: true,
  drive: (context) =>
    Effect.gen(function* () {
      const waiting = yield* context.wait.pipe(
        schedule.apply,
        Effect.forkDetach({ startImmediately: true }),
      );
      yield* context.startActor;
      sendAll(context.actor, context.driverSends);
      return waiting;
    }),
  reached: () => true,
});

/** The wait observes the state and settles before `start`; `start` and the writes come after. */
const beforeStart: Start = {
  family: "before start",
  value: 0,
  stops: false,
  ownsStart: true,
  drive: (context) =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      context.recorder.onStart = () => signal(started);
      const waiting = yield* Effect.forkDetach(context.wait);
      yield* Deferred.await(started);
      yield* context.quiet;
      yield* context.startActor;
      sendAll(context.actor, context.driverSends);
      return waiting;
    }),
  reached: startsBeforeStart,
};

/**
 * Send at the next scheduling point, not inside the step that runs the hook. A wait's first
 * observation is one synchronous step in real use, so no write can land inside it.
 */
const sendSoon = (actor: OrderActor, events: ReadonlyArray<EventTag>): void => {
  startNow(
    Effect.andThen(
      Effect.yieldNow,
      Effect.sync(() => sendAll(actor, events)),
    ),
  );
};

/** A racing start for a named case: the run must start the wait before any write. */
const raceFirst = (schedule: Schedule): Start => ({ ...race(schedule), reached: startsFirst });

/** The writes land at the first scheduling point after the wait's first observation. */
const afterStart: Start = {
  family: "writes right after the start",
  value: 0,
  stops: false,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      context.recorder.onStart = () => sendSoon(context.actor, context.driverSends);
      return yield* Effect.forkDetach(context.wait);
    }),
  reached: startsFirst,
};

/** The writes land at the first scheduling point after the predicate's first call. */
const afterFirstCall: Start = {
  family: "writes right after the first call",
  value: 0,
  stops: false,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      context.afterFirstCall = () => sendSoon(context.actor, context.driverSends);
      return yield* Effect.forkDetach(context.wait);
    }),
  reached: startsFirst,
};

/**
 * Hold the `latestTransition` permit from inside write `k`. Every writer except recovery sets
 * `latestTransition` after it writes the state and before it notifies: a transition, a startup
 * immediate transition and a supervised restart.
 */
const holdAtWrite = (context: RunContext, k: number, written: Deferred.Deferred<void>): void => {
  context.recorder.onWrite = (index) => {
    if (index !== k) return;
    holdPermit(context.actor.latestTransition.semaphore);
    signal(written);
  };
};

/** The wait starts after write `k` and before its notification. `start` writes `k` when `duringStart`. */
const gap = (k: number, duringStart = false): Start => ({
  family: "between write and notification",
  value: k,
  stops: false,
  ownsStart: duringStart,
  drive: (context) =>
    Effect.gen(function* () {
      const permit = context.actor.latestTransition.semaphore;
      const written = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      holdAtWrite(context, k, written);
      context.recorder.onStart = () => signal(started);
      // `start` writes `k` and then waits for the held permit.
      let starting: Fiber.Fiber<void> | undefined;
      if (duringStart) starting = yield* Effect.forkDetach(context.startActor);
      else sendAll(context.actor, context.driverSends);
      yield* Deferred.await(written);
      const waiting = yield* Effect.forkDetach(context.wait);
      yield* Deferred.await(started);
      yield* permit.release(1);
      if (starting !== undefined) {
        yield* Fiber.join(starting);
        sendAll(context.actor, context.driverSends);
      }
      return waiting;
    }),
  reached: (log) => {
    const start = startIndex(log);
    const written = writeAt(log, k);
    const next = writeAt(log, k + 1);
    return (
      start !== -1 &&
      written !== -1 &&
      written < start &&
      (next === -1 || start < next) &&
      !log.slice(written, start).some(isNotifyBegin)
    );
  },
});

/** The wait starts from a `subscribe` callback, inside notification `j`. `start` notifies `j` when `duringStart`. */
const inNotification = (j: number, duringStart = false): Start => ({
  family: "inside a notification",
  value: j,
  stops: false,
  ownsStart: duringStart,
  drive: (context) =>
    Effect.gen(function* () {
      const reached = Deferred.makeUnsafe<void>();
      const fibers: Array<Fiber.Fiber<Exit.Exit<OrderState, ActorStoppedError>>> = [];
      context.recorder.onNotify = (index) => {
        if (index !== j) return;
        fibers.push(startNow(context.counted(context.wait)));
        signal(reached);
      };
      if (duringStart) yield* context.startActor;
      sendAll(context.actor, context.driverSends);
      yield* Deferred.await(reached);
      return fibers[0]!;
    }),
  reached: (log) => {
    const start = startIndex(log);
    return notifyAt(log, "begin", j) < start && start < notifyAt(log, "end", j);
  },
});

/** The wait starts in the same fiber, right after an earlier `waitFor` matched `tag`. */
const afterMatch = (tag: Tag): Start => ({
  family: "after an earlier wait matched",
  value: tag,
  stops: false,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      const called = Deferred.makeUnsafe<void>();
      const earlier = context.actor.waitFor((state) => {
        signal(called);
        return state._tag === tag;
      });
      const waiting = yield* Effect.andThen(earlier, context.wait).pipe(
        Effect.catch((error) => Effect.succeed(Exit.fail(error))),
        Effect.forkDetach,
      );
      yield* Deferred.await(called);
      // Let the earlier wait settle on its snapshot before the writes.
      yield* Effect.yieldNow;
      sendAll(context.actor, context.driverSends);
      return waiting;
    }),
  reached: (log) => {
    const start = startIndex(log);
    const begins = log.flatMap((entry, position) => {
      if (entry.kind === "notify" && entry.phase === "begin" && position < start) {
        return [entry.index];
      }
      return [];
    });
    const index = begins.at(-1);
    return index !== undefined && start < notifyAt(log, "end", index);
  },
});

/** Stop the actor once `written` completes; release the permit once the wait settled. */
const stopInHeldGap = (
  context: RunContext,
  waiting: Fiber.Fiber<Exit.Exit<OrderState, ActorStoppedError>>,
  written: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    yield* Deferred.await(written);
    yield* context.actor.stop.pipe(Effect.forkDetach);
    yield* Fiber.await(waiting).pipe(
      Effect.timeoutOption("1 second"),
      Effect.andThen(context.actor.latestTransition.semaphore.release(1)),
      Effect.forkDetach,
    );
  });

/**
 * The wait starts after events `[0, i)` settled. Then event `i` is written, and the actor stops
 * before it notifies that write (the harness holds the `latestTransition` permit).
 */
const stopInGap = (i: number): Start => ({
  family: "stop before the notification of event",
  value: i,
  stops: true,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      for (const event of context.driverSends.slice(0, i)) {
        yield* context.actor.call(eventOf[event]);
      }
      const permit = context.actor.latestTransition.semaphore;
      yield* permit.take(1);
      const written = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      const writesBefore = context.recorder.writes();
      context.recorder.onWrite = (index) => {
        if (index === writesBefore + 1) signal(written);
      };
      context.recorder.onStart = () => signal(started);
      const waiting = yield* Effect.forkDetach(context.wait);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      if (!context.form.sendsItself) {
        context.actor.client.send(eventOf[context.driverSends[i]!]);
      }
      yield* stopInHeldGap(context, waiting, written);
      return waiting;
    }),
  reached: (log) => {
    const start = startIndex(log);
    const writes = writesIn(log).length - 1;
    return (
      start !== -1 &&
      writesIn(log.slice(start)).length === 1 &&
      notifyAt(log, "begin", writes) === -1 &&
      (notifyAt(log, "begin", writes - 1) !== -1) === writes > 1
    );
  },
});

/**
 * The wait starts before the events. Write `k` lands (a supervised restart's write included),
 * and the actor stops before anything notifies it (the harness holds the permit from inside the
 * write).
 */
const stopAtWrite = (k: number): Start => ({
  family: "stop before the notification of write",
  value: k,
  stops: true,
  ownsStart: false,
  drive: (context) =>
    Effect.gen(function* () {
      const written = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      holdAtWrite(context, k, written);
      context.recorder.onStart = () => signal(started);
      const waiting = yield* Effect.forkDetach(context.wait);
      yield* Deferred.await(started);
      yield* Effect.yieldNow;
      sendAll(context.actor, context.driverSends);
      yield* stopInHeldGap(context, waiting, written);
      return waiting;
    }),
  reached: (log) => {
    const start = startIndex(log);
    const written = writeAt(log, k);
    return (
      start !== -1 &&
      written > start &&
      writeAt(log, k + 1) === -1 &&
      !log.slice(written).some(isNotifyBegin)
    );
  },
});

/** Every start point for one form and scenario, besides the racing schedules. */
const positionsFor = (form: Form, scenario: Scenario): ReadonlyArray<Start> => {
  const starts: Array<Start> = [];
  const driverCount = driverSendsOf(form, scenario).length;
  // A form that sends can start only before its own event's writes.
  let reachable = scenario.writes.length;
  if (form.sendsItself) reachable = scenario.prefixWrites;
  // A form that sends before `start` queues its event before the harness's events.
  if (driverCount === 0 || !form.sendsItself) starts.push(beforeStart);
  if (!form.sendsItself) starts.push(afterStart);
  if (!form.sendsItself && form.takesPredicate) starts.push(afterFirstCall);
  for (let j = 1; j <= reachable; j += 1) {
    // A recovery write notifies in the same synchronous step: no wait can start in between.
    const duringStart = j <= scenario.startupWrites;
    if (j > scenario.recoveryWrites) starts.push(gap(j, duringStart));
    if (j <= scenario.notifies.length) starts.push(inNotification(j, duringStart));
  }
  // A tag that one event writes once in the run, and not the state before the writes.
  const once = scenario.writes
    .slice(scenario.startupWrites, reachable)
    .filter(
      (tag) => [OrderState.Idle._tag, ...scenario.writes].filter((t) => t === tag).length === 1,
    );
  for (const tag of once) starts.push(afterMatch(tag));
  if (scenario.stoppable && form.sendsItself) starts.push(stopInGap(driverCount));
  if (scenario.stoppable && !form.sendsItself) {
    for (let i = 0; i < driverCount; i += 1) starts.push(stopInGap(i));
  }
  // Restart writes: a stop before the notification of each write after `start`.
  if (scenario.restarts && scenario.live) {
    for (let k = scenario.startupWrites + 1; k <= scenario.writes.length; k += 1) {
      starts.push(stopAtWrite(k));
    }
  }
  return starts;
};

// ---------------------------------------------------------------------------
// Runs and their judgement
// ---------------------------------------------------------------------------

interface Case {
  readonly form: Form;
  readonly scenario: Scenario;
  readonly predicate: PredicateCase;
  readonly start: Start;
}

interface Run {
  readonly log: ReadonlyArray<Entry>;
  readonly calls: ReadonlyArray<Tag>;
  readonly reentered: boolean;
  readonly outcome: string;
  readonly actorFinished: boolean;
  /** A live run, judged while the actor still ran: the wait's outcome then, or pending or busy. */
  readonly live?: { readonly outcome: string; readonly actorExited: boolean };
  /** Registrations above the count before the wait: once it settled while the actor ran, and at the end. */
  readonly held: { readonly settledLive: number; readonly end: number };
}

const describeExit = (exit: Exit.Exit<OrderState, ActorStoppedError>): string =>
  Exit.match(exit, {
    onSuccess: (state) => state._tag,
    onFailure: (cause) =>
      Option.match(Exit.findErrorOption(Exit.failCause(cause)), {
        onNone: () => {
          if (Cause.hasInterrupts(cause)) return "interrupted";
          return "defect";
        },
        onSome: (error) => error._tag,
      }),
  });

const hostTurns = new Scheduler.MixedScheduler().makeDispatcher();

/**
 * One turn of the host's macrotask queue, where every fiber's dispatcher runs its batches. A
 * standalone dispatcher, so the turn does not wait behind the harness fiber's own batch.
 */
const hostTurn = Effect.callback<void>((resume) => {
  hostTurns.scheduleTask(() => resume(Effect.void), 0);
});

/**
 * Wait until neither the log nor the wait's fibers move for 40 host turns in a row. False when
 * they keep moving.
 */
const quiesce = (moves: () => string) =>
  Effect.gen(function* () {
    let still = 0;
    let last = moves();
    for (let turn = 0; turn < 5000; turn += 1) {
      yield* hostTurn;
      const now = moves();
      if (now !== last) {
        still = 0;
        last = now;
      } else {
        still += 1;
        if (still === 40) return true;
      }
    }
    return false;
  });

// The time limits only make a hang visible as a test failure; the waits under test have none.
const run = ({ form, scenario, predicate, start }: Case) => {
  let operations = 0;
  const counted = countingWaitOperations(() => {
    operations += 1;
  });
  return Effect.gen(function* () {
    const actor = yield* scenario.spawn;
    const registrations = trackRegistrations(actor.state);
    const recorder = record(actor, scenario);
    let actorExited = false;
    yield* actor.awaitExit.pipe(
      Effect.andThen(
        Effect.sync(() => {
          actorExited = true;
        }),
      ),
      Effect.forkDetach({ startImmediately: true }),
    );
    // After the harness's own exit watcher registered, so only the waits under test count.
    const baseline = registrations();
    const calls: Array<Tag> = [];
    let depth = 0;
    let reentered = false;
    const judge = predicate.make((event) => actor.client.send(eventOf[event]));
    const lastEvent = eventOf[scenario.sends[scenario.sends.length - 1]!];
    const context: RunContext = {
      actor,
      scenario,
      recorder,
      form,
      startActor: Effect.andThen(
        actor.start,
        Effect.sync(() => {
          recorder.log.push({ kind: "started" });
        }),
      ),
      driverSends: driverSendsOf(form, scenario),
      afterFirstCall: () => undefined,
      counted,
      quiet: quiesce(() => `${recorder.log.length}/${operations}`),
      wait: Effect.suspend(() => {
        recorder.log.push({ kind: "call" });
        return form.wait(actor, lastEvent, (state) => {
          if (depth > 0) reentered = true;
          depth += 1;
          calls.push(state._tag);
          const accepted = judge(state);
          depth -= 1;
          if (calls.length === 1) context.afterFirstCall();
          return accepted;
        });
      }).pipe(Effect.exit, Effect.provideService(UnderTest, true)),
    };
    // The guard runs the drive in its own fiber, so the drive forks detached fibers that
    // outlive it; the run interrupts them when they do not settle.
    if (!start.ownsStart) yield* context.startActor;
    const driven = yield* start.drive(context).pipe(Effect.timeoutOption("1 second"));
    if (Option.isNone(driven)) {
      yield* actor.stop;
      const stuck: Run = {
        log: [...recorder.log],
        calls,
        reentered,
        outcome: "the harness did not reach the start point",
        actorFinished: true,
        held: { settledLive: 0, end: 0 },
      };
      return stuck;
    }
    const waiting = driven.value;
    let live: Run["live"];
    let settledLive = 0;
    if (scenario.live && !start.stops) {
      const quiet = yield* context.quiet;
      const settled = waiting.pollUnsafe();
      let outcome = "busy";
      if (settled !== undefined) {
        settledLive = registrations() - baseline;
        outcome = Exit.match(settled, {
          onSuccess: describeExit,
          onFailure: () => "the wait's fiber was interrupted",
        });
      } else if (quiet) outcome = "pending";
      live = { outcome, actorExited };
      yield* actor.stop;
    }
    const finished = yield* actor.awaitExit.pipe(Effect.timeoutOption("2 seconds"));
    if (Option.isNone(finished)) yield* actor.stop;
    const exit = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("100 millis"));
    if (Option.isNone(exit)) yield* Fiber.interrupt(waiting);
    const outcome = Option.match(exit, {
      onNone: () => "hang",
      onSome: Exit.match({
        onSuccess: describeExit,
        onFailure: () => "the wait's fiber was interrupted",
      }),
    });
    return {
      log: [...recorder.log],
      calls,
      reentered,
      outcome,
      actorFinished: Option.isSome(finished),
      live,
      held: { settledLive, end: registrations() - baseline },
    } satisfies Run;
  }).pipe(counted);
};

/** The in-order first match over `states`, by replaying a fresh, silent predicate. */
const replay = (states: ReadonlyArray<Tag>, testCase: Case) => {
  if (!testCase.form.takesPredicate) {
    const final = states.find((tag) => tag === "Done");
    return { calls: [], outcome: final ?? "ActorStoppedError" };
  }
  const judge = testCase.predicate.make(() => undefined);
  const calls: Array<Tag> = [];
  for (const tag of states) {
    calls.push(tag);
    if (judge(OrderState[tag])) return { calls, outcome: tag };
  }
  return { calls, outcome: "ActorStoppedError" };
};

interface Violation {
  readonly kind: string;
  /** The case without its position, so one line lists every position that breaks it. */
  readonly group: string;
  readonly start: Start;
  readonly detail: string;
}

/** While a live actor runs, a wait ends at its match, and a wait without one sleeps. */
const judgeLive = (live: NonNullable<Run["live"]>, expected: string): ReadonlyArray<string> => {
  const kinds: Array<string> = [];
  if (live.actorExited) kinds.push("the live actor terminated by itself");
  if (live.outcome === "busy") kinds.push("the wait kept running while no state was written");
  else if (expected === "ActorStoppedError" && live.outcome !== "pending") {
    kinds.push("the wait ended without a match while the actor ran");
  } else if (expected !== "ActorStoppedError" && live.outcome !== expected) {
    kinds.push("the wait did not end at its match while the actor ran");
  }
  return kinds;
};

/** Judge one run against its log. */
const judgeRun = (testCase: Case, result: Run): Violation | undefined => {
  const kinds: Array<string> = [];
  const start = startIndex(result.log);
  let expected = { calls: new Array<Tag>(), outcome: "?" };
  if (start === -1) kinds.push("the wait never observed the state");
  else {
    const held = writesIn(result.log.slice(0, start)).at(-1)!;
    expected = replay([held, ...writesIn(result.log.slice(start))], testCase);
    if (testCase.form.sendsItself) {
      // Only `start` writes besides the form before it observes: a write past the startup
      // writes that lands between the call and the observation comes from its own send.
      const call = indexOf(result.log, (entry) => entry.kind === "call");
      const startup = writeAt(result.log, testCase.scenario.startupWrites);
      const early = result.log
        .slice(call, start)
        .filter((entry, offset) => entry.kind === "write" && call + offset > startup);
      if (early.length > 0) kinds.push("observed after its send");
    }
    if (testCase.form.takesPredicate && result.calls.join(">") !== expected.calls.join(">")) {
      kinds.push("calls differ from the write log");
    }
    if (result.outcome !== expected.outcome) kinds.push("wrong outcome");
    if (result.live !== undefined) kinds.push(...judgeLive(result.live, expected.outcome));
  }
  if (result.held.settledLive > 0)
    kinds.push("a settled wait kept a registration while the actor ran");
  if (result.held.end > 0) kinds.push("a finished wait kept a registration");
  if (result.reentered) kinds.push("a predicate call started inside another");
  if (!result.actorFinished) kinds.push("the actor did not finish");
  if (!testCase.start.reached(result.log)) kinds.push("the start point was not reached");
  // A form that sends from inside a notification puts its event before the harness's later
  // ones, so only runs where the form's event is the only one keep the declared writes.
  const fullRun =
    !testCase.predicate.sends &&
    !testCase.start.stops &&
    (!testCase.form.sendsItself || testCase.scenario.sends.length === 1);
  if (fullRun && writesIn(result.log).slice(1).join(">") !== testCase.scenario.writes.join(">")) {
    kinds.push("the writes differ from the scenario");
  }
  if (fullRun && notifiesIn(result.log).join(">") !== testCase.scenario.notifies.join(">")) {
    kinds.push("the notifications differ from the scenario");
  }
  if (kinds.length === 0) return undefined;
  const kind = kinds.join(", ");
  return {
    kind,
    group: `${kind}: ${testCase.form.name} | ${testCase.scenario.name} | ${testCase.predicate.name} | ${testCase.start.family}`,
    start: testCase.start,
    detail: `expected calls=${expected.calls.join(">")} outcome=${expected.outcome}; got calls=${result.calls.join(">")} outcome=${result.outcome} live=${result.live?.outcome ?? "-"}; writes=${writesIn(result.log).join(">")}`,
  };
};

const runCase = (testCase: Case) =>
  run(testCase).pipe(
    Effect.map((result) => ({ violation: judgeRun(testCase, result), result })),
    Effect.provide(ActorSystemDefault),
  );

const predicatesFor = (form: Form): ReadonlyArray<PredicateCase> =>
  // A form without a predicate gets one placeholder, so each position runs once.
  predicateCases.filter((predicate) => form.takesPredicate || predicate === never);

const racingCases = (form: Form): ReadonlyArray<Case> => {
  let scenarios = allScenarios;
  if (form.sendsItself) scenarios = alone(allScenarios);
  return scenarios.flatMap((scenario) =>
    predicatesFor(form).flatMap((predicate) =>
      schedules.map((schedule) => ({ form, scenario, predicate, start: race(schedule) })),
    ),
  );
};

/** The start races `actor.start`, in every scenario whose start writes. */
const startRacingCases = (form: Form): ReadonlyArray<Case> => {
  let scenarios = allScenarios.filter(({ startupWrites }) => startupWrites > 0);
  if (form.sendsItself) scenarios = alone(scenarios);
  return scenarios.flatMap((scenario) =>
    predicatesFor(form).flatMap((predicate) =>
      schedules.map((schedule) => ({ form, scenario, predicate, start: raceStart(schedule) })),
    ),
  );
};

const positionCases = (form: Form): ReadonlyArray<Case> =>
  allScenarios.flatMap((scenario) =>
    predicatesFor(form).flatMap((predicate) =>
      positionsFor(form, scenario).map((start) => ({ form, scenario, predicate, start })),
    ),
  );

/** "budget 3-7,9; yield at 14-19" */
const describePositions = (starts: ReadonlyArray<Start>): string => {
  const families = [...new Set(starts.map(({ family }) => family))];
  return families
    .map((family) => {
      const values = starts.filter((s) => s.family === family).map(({ value }) => value);
      const ranges: Array<[number | string, number | string]> = [];
      for (const value of values) {
        const last = ranges.at(-1);
        if (last !== undefined && typeof value === "number" && last[1] === value - 1) {
          last[1] = value;
        } else ranges.push([value, value]);
      }
      const text = ranges.map(([from, to]) => [...new Set([from, to])].join("-"));
      return `${family} ${text.join(",")}`;
    })
    .join("; ");
};

/** Check every case. Racing cases must also prove that some runs start before the writes. */
const checkProperty = (cases: ReadonlyArray<Case>) =>
  Effect.gen(function* () {
    const verdicts = yield* Effect.forEach(cases, runCase);
    const violations = verdicts.flatMap(({ violation }) =>
      [violation].filter((value) => value !== undefined),
    );
    const byKind: Record<string, number> = {};
    const byGroup: Record<string, Array<Violation>> = {};
    for (const violation of violations) {
      byKind[violation.kind] = (byKind[violation.kind] ?? 0) + 1;
      (byGroup[violation.group] ??= []).push(violation);
    }
    const brokenCases = Object.entries(byGroup).map(
      ([group, list]) =>
        `${group} @ ${describePositions(list.map(({ start }) => start))} — first: ${list[0]!.detail}`,
    );
    expect({
      runs: verdicts.length,
      violations: violations.length,
      byKind,
      brokenCases,
    }).toEqual({ runs: cases.length, violations: 0, byKind: {}, brokenCases: [] });
    const racing = cases.some(
      ({ form, start }) =>
        !form.sendsItself && (start.family === "budget" || start.family === "yield at"),
    );
    if (racing) {
      // A racing wait that never starts first would never meet the brief states.
      expect(verdicts.some(({ result }) => startsFirst(result.log))).toBe(true);
    }
    if (cases.some(({ start }) => start.family.endsWith(", then start"))) {
      // A wait that never starts before `start` would never meet the startup writes.
      expect(verdicts.some(({ result }) => startsBeforeStart(result.log))).toBe(true);
    }
  });

/**
 * Counterexamples from earlier reviews, each the case that was red on the code named in its
 * title. Each also asserts that it reaches its start point. The properties own the class.
 */
const namedCases: ReadonlyArray<readonly [string, Case]> = [
  [
    "D1: a wait between a write and its notification judges that state once (red on c9edb01)",
    { form: waitForForm, scenario: sentShort, predicate: never, start: gap(1) },
  ],
  [
    "D1: a wait between a write and its notification gets its second call right (red on c9edb01)",
    { form: waitForForm, scenario: sentShort, predicate: nthCall(2), start: gap(1) },
  ],
  [
    "D1: a wait that starts after an earlier match judges that state once (red on c9edb01)",
    { form: waitForForm, scenario: sentShort, predicate: nthCall(2), start: afterMatch("Working") },
  ],
  [
    "D1: a wait started from a subscribe callback judges that state once (red on c9edb01)",
    { form: waitForForm, scenario: sentShort, predicate: never, start: inNotification(1) },
  ],
  [
    "D1: a rewrite of the same object that a stop overtakes is judged (red on c9edb01)",
    { form: waitForForm, scenario: ping, predicate: nthCall(2), start: stopInGap(1) },
  ],
  [
    "D2: the snapshot is judged when the wait yields before it judges (red on m3-snapshot-if-quiet)",
    { form: waitForForm, scenario: sentShort, predicate: is("Idle"), start: raceFirst(budget(15)) },
  ],
  [
    "the snapshot is judged when writes land right after the start (red on 893c29c)",
    { form: waitForForm, scenario: sentShort, predicate: never, start: afterStart },
  ],
  [
    "D3: a predicate that sends cannot re-enter the wait (waitFor, red on c9edb01)",
    {
      form: waitForForm,
      scenario: sentShort,
      predicate: sendsOn("Idle", "Work", every),
      start: afterFirstCall,
    },
  ],
  [
    "D3: a predicate that sends cannot re-enter the wait (sendAndWait, red on c9edb01)",
    {
      form: sendAndWaitForm,
      scenario: finishOnly,
      predicate: sendsOn("Idle", "Work", every),
      start: raceFirst(budget(64)),
    },
  ],
  [
    "a brief Working right after the start is kept (r1 M2, red on df154f2)",
    { form: waitForForm, scenario: sentShort, predicate: is("Working"), start: afterStart },
  ],
  [
    "the first match wins over a later one (r1 M2, red on df154f2)",
    {
      form: waitForForm,
      scenario: sentLong,
      predicate: oneOf("Working", "Other"),
      start: afterStart,
    },
  ],
  [
    "sendAndWait keeps a brief target that its send causes (r1 M3, red on df154f2)",
    {
      form: sendAndWaitForm,
      scenario: brief,
      predicate: is("Working"),
      start: raceFirst(budget(16)),
    },
  ],
  [
    "sendAndWait judges the snapshot before later states (r2 C2, red on 893c29c)",
    {
      form: sendAndWaitForm,
      scenario: brief,
      predicate: after("Idle", "Working"),
      start: raceFirst(budget(5)),
    },
  ],
  [
    "a predicate that accepts its second call gets the second write (r2 C2, red on df154f2)",
    { form: waitForForm, scenario: sentShort, predicate: nthCall(2), start: afterFirstCall },
  ],
  [
    "a wait ends when the actor finishes without a match (red on 0c24e11)",
    { form: waitForForm, scenario: sentShort, predicate: is("Other"), start: afterStart },
  ],
  [
    "a match whose notification a stop overtakes succeeds (r1 M4, red on 0c24e11)",
    { form: waitForForm, scenario: sentShort, predicate: is("Working"), start: stopInGap(0) },
  ],
  [
    "a written match whose entry crashes before the restart is kept (r2 N3, red on c9edb01)",
    { form: waitForForm, scenario: restartCrash, predicate: is("Working"), start: afterFirstCall },
  ],
  [
    "a restart's late notification does not reorder the writes (r2 N2, red on c9edb01)",
    {
      form: waitForForm,
      scenario: restartStale,
      predicate: after("Working", "Ready"),
      start: afterFirstCall,
    },
  ],
  [
    "a wait from before start judges the startup write (R1 PRE-1, red on 0c24e11)",
    { form: waitForForm, scenario: startupLive, predicate: nthCall(2), start: beforeStart },
  ],
  [
    "a wait started in the recovery notification judges each state once (R1 PRE-3, red on 0c24e11)",
    {
      form: waitForForm,
      scenario: recoverImmediate,
      predicate: never,
      start: inNotification(1, true),
    },
  ],
  [
    "a wait from before start ends at a recovered match while the actor runs (R1-M3, red on mut-no-recovery-notify)",
    { form: waitForForm, scenario: recoverLive, predicate: is("Working"), start: beforeStart },
  ],
  [
    "a wait ends at a later match while the actor runs (R1-M3, red on mut-no-ring)",
    { form: waitForForm, scenario: liveWork, predicate: is("Working"), start: afterStart },
  ],
  [
    "a wait without a match does no work while no state is written (R1-M3, red on mut-once-wake)",
    { form: waitForForm, scenario: liveWork, predicate: never, start: afterStart },
  ],
];

describe("a wait observes every state written from its start, in order", () => {
  for (const [name, testCase] of namedCases) {
    it.live(name, () =>
      Effect.map(runCase(testCase), ({ violation, result }) =>
        expect({ reached: testCase.start.reached(result.log), violation }).toEqual({
          reached: true,
          violation: undefined,
        }),
      ),
    );
  }
  for (const form of forms) {
    it.live(
      `${form.name}, with the writes racing its start`,
      () => checkProperty(racingCases(form)),
      300_000,
    );
    it.live(
      `${form.name}, with its start racing actor.start`,
      () => checkProperty(startRacingCases(form)),
      300_000,
    );
    it.live(
      `${form.name}, from every other start point`,
      () => checkProperty(positionCases(form)),
      300_000,
    );
  }
});
