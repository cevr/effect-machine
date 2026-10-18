// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Scheduler } from "effect";
import type { Semaphore } from "effect";
import { describe, expect, it } from "effect-bun-test";

import type { ActorStoppedError } from "../src/index.js";
import { ActorSystemDefault, Event, Machine, State, Supervision } from "../src/index.js";

// Property: a wait observes every state written from the moment it subscribes, in write order,
// each once, and succeeds with the first one that matches. `sendAndWait` subscribes before it
// sends. A predicate call never starts inside another one.
//
// Oracle: the harness records every write of the actor's state ref, its own notifications, and
// the moment the wait under test first observes the state (it reads the ref or subscribes to the
// ref's publication). The actor never reads this log. The expected states are the state held at
// that moment and every later write; the expected calls and outcome come from a fresh copy of
// the predicate replayed over them. Nothing in the oracle comes from the wait's result or calls.

const OrderState = State({ Idle: {}, Ready: {}, Working: {}, Other: {}, Done: {} });
type OrderState = typeof OrderState.Type;
type Tag = OrderState["_tag"];
const OrderEvent = Event({ Work: {}, Next: {}, Ping: {}, Finish: {} });
type OrderEvent = typeof OrderEvent.Type;
type EventTag = OrderEvent["_tag"];
const eventOf: { readonly [E in EventTag]: OrderEvent } = {
  Work: OrderEvent.Work,
  Next: OrderEvent.Next,
  Ping: OrderEvent.Ping,
  Finish: OrderEvent.Finish,
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
  /** How many of `writes` (and notifications) come before the last event's writes. */
  readonly prefixWrites: number;
  /** A supervised restart writes state outside the event loop's write-then-notify order. */
  readonly restarts: boolean;
}

const plain = (
  name: string,
  machine: OrderMachine,
  sends: readonly [EventTag, ...Array<EventTag>],
  writes: ReadonlyArray<Tag>,
  prefixWrites: number,
): Scenario => ({
  name,
  spawn: spawnOrder(machine),
  sends,
  writes,
  notifies: writes,
  startupWrites: 0,
  prefixWrites,
  restarts: false,
});

const sentShort = plain(
  "test sends Work,Finish",
  makeMachine(),
  ["Work", "Finish"],
  ["Working", "Done"],
  1,
);
const sentLong = plain(
  "test sends Work,Next,Finish",
  makeMachine(),
  ["Work", "Next", "Finish"],
  ["Working", "Other", "Done"],
  2,
);
const finishOnly = plain("test sends Finish", makeMachine(), ["Finish"], ["Done"], 0);
const brief = plain(
  "Working sends Finish",
  makeMachine().spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Finish)),
  ["Work"],
  ["Working", "Done"],
  0,
);
const chain = plain(
  "Working sends Next, Other sends Finish",
  makeMachine()
    .spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Next))
    .spawn(OrderState.Other, ({ self }) => self.send(OrderEvent.Finish)),
  ["Work"],
  ["Working", "Other", "Done"],
  0,
);
const ping = plain(
  "test sends Work,Ping,Finish (Ping rewrites the same object)",
  makeMachine(),
  ["Work", "Ping", "Finish"],
  ["Working", "Working", "Done"],
  2,
);
// r2 N3: Working is written, its entry crashes before the notification, and the restart
// writes Idle over it.
const restartCrash: Scenario = {
  name: "Working's entry crashes, the actor restarts",
  spawn: spawnRestarting((machine) => machine),
  sends: ["Work"],
  gate: { event: "Finish", afterNotify: "Idle" },
  writes: ["Working", "Idle", "Done"],
  notifies: ["Idle", "Done"],
  startupWrites: 0,
  prefixWrites: 0,
  restarts: true,
};
// r2 N2: the restart writes Idle, the new generation writes and notifies Ready, then the restart
// notifies Idle.
const restartStale: Scenario = {
  name: "Ready's Working entry crashes, the restart notifies late",
  spawn: spawnRestarting((machine) =>
    machine
      .immediate(OrderState.Idle, () => OrderState.Ready)
      .on(OrderState.Ready, OrderEvent.Work, () => OrderState.Working),
  ),
  sends: ["Work"],
  gate: { event: "Finish", afterNotify: "Idle" },
  writes: ["Ready", "Working", "Idle", "Ready", "Done"],
  notifies: ["Ready", "Ready", "Idle", "Done"],
  startupWrites: 1,
  prefixWrites: 1,
  restarts: true,
};

const racingScenarios = [sentShort, sentLong, finishOnly, brief, chain, ping];
const restartScenarios = [restartCrash, restartStale];
// A form that sends starts with no other writer: its own event comes last and alone.
const sendingScenarios = [finishOnly, brief, chain, ...restartScenarios];

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
  /** Runs inside the write, before it is published: it must not touch the actor. */
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

// ---------------------------------------------------------------------------
// Start points
// ---------------------------------------------------------------------------

interface RunContext {
  readonly actor: OrderActor;
  readonly scenario: Scenario;
  readonly recorder: Recorder;
  readonly form: Form;
  /** The wait under test, marked, logging its call first. */
  readonly wait: Effect.Effect<Exit.Exit<OrderState, ActorStoppedError>>;
  /** Events the harness sends: all of them, or all but the form's own last one. */
  readonly driverSends: ReadonlyArray<EventTag>;
  /** Runs synchronously after the predicate's first call returns. */
  afterFirstCall: () => void;
}

interface Start {
  readonly family: string;
  readonly value: number | string;
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
// Synchronous steps inside listener callbacks, where no fiber can be suspended.
const holdPermit = (permit: Semaphore.Semaphore): void => {
  Effect.runSync(permit.take(1));
};
const startNow = <A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> => Effect.runFork(effect);

const startIndex = (log: ReadonlyArray<Entry>): number =>
  indexOf(log, (entry) => entry.kind === "start");
/** The wait starts before every write after the actor started. */
const startsFirst = (log: ReadonlyArray<Entry>): boolean => {
  const start = startIndex(log);
  const started = indexOf(log, (entry) => entry.kind === "started");
  return start > started && writesIn(log.slice(started, start)).length === 0;
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

/** The default scheduler, except that the wait yields once, `offset` operations in. */
const yieldAt = (offset: number): Schedule => ({
  family: "yield at",
  value: offset,
  apply: (wait) =>
    Effect.flatMap(Effect.service(Scheduler.Scheduler), (base) => {
      let operations = 0;
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        shouldYield: () => {
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
 * r3's start points: the wait runs at once until the schedule makes it yield, and the writes
 * are sent right after that, with no handshake. A send runs the actor's loop in the sender's
 * call, so a wait that only starts later would see every write already done.
 */
const race = (schedule: Schedule): Start => ({
  family: schedule.family,
  value: schedule.value,
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
  drive: (context) =>
    Effect.gen(function* () {
      context.afterFirstCall = () => sendSoon(context.actor, context.driverSends);
      return yield* Effect.forkDetach(context.wait);
    }),
  reached: startsFirst,
};

/**
 * The wait starts after write `k` and before its notification. The loop writes the state, then
 * needs the `latestTransition` permit before it notifies, so the harness holds that permit.
 */
const gap = (k: number): Start => ({
  family: "between write and notification",
  value: k,
  drive: (context) =>
    Effect.gen(function* () {
      const permit = context.actor.latestTransition.semaphore;
      const written = Deferred.makeUnsafe<void>();
      const started = Deferred.makeUnsafe<void>();
      if (k === 1) yield* permit.take(1);
      context.recorder.onNotify = (index) => {
        if (index === k - 1) holdPermit(permit);
      };
      context.recorder.onWrite = (index) => {
        if (index === k) signal(written);
      };
      context.recorder.onStart = () => signal(started);
      sendAll(context.actor, context.driverSends);
      yield* Deferred.await(written);
      const waiting = yield* Effect.forkDetach(context.wait);
      yield* Deferred.await(started);
      yield* permit.release(1);
      return waiting;
    }),
  reached: (log) => {
    const start = startIndex(log);
    const before = log.slice(0, start);
    return (
      start !== -1 &&
      writesIn(before).length === k + 1 &&
      notifyAt(before, "begin", k) === -1 &&
      (notifyAt(before, "begin", k - 1) !== -1) === k > 1
    );
  },
});

/** The wait starts from a `subscribe` callback, inside notification `j`. */
const inNotification = (j: number): Start => ({
  family: "inside a notification",
  value: j,
  drive: (context) =>
    Effect.gen(function* () {
      const reached = Deferred.makeUnsafe<void>();
      const fibers: Array<Fiber.Fiber<Exit.Exit<OrderState, ActorStoppedError>>> = [];
      context.recorder.onNotify = (index) => {
        if (index !== j) return;
        fibers.push(startNow(context.wait));
        signal(reached);
      };
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

/**
 * The wait starts after events `[0, i)` settled. Then event `i` is written, and the actor stops
 * before it notifies that write (the harness holds the `latestTransition` permit).
 */
const stopInGap = (i: number): Start => ({
  family: "stop before the notification of event",
  value: i,
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
      yield* Deferred.await(written);
      yield* context.actor.stop.pipe(Effect.forkDetach);
      yield* Fiber.await(waiting).pipe(
        Effect.timeoutOption("1 second"),
        Effect.andThen(permit.release(1)),
        Effect.forkDetach,
      );
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

/** Every start point for one form and scenario, besides the racing schedules. */
const positionsFor = (form: Form, scenario: Scenario): ReadonlyArray<Start> => {
  const starts: Array<Start> = [];
  const driverCount = driverSendsOf(form, scenario).length;
  // A form that sends can start only before its own event's writes.
  let reachable = scenario.writes.length;
  if (form.sendsItself) reachable = scenario.prefixWrites;
  if (!form.sendsItself) starts.push(afterStart);
  if (!form.sendsItself && form.takesPredicate) starts.push(afterFirstCall);
  for (let j = scenario.startupWrites + 1; j <= reachable; j += 1) {
    if (!scenario.restarts) starts.push(gap(j));
    if (j <= scenario.notifies.length) starts.push(inNotification(j));
  }
  // A tag that appears once in the run, and not in the state before the writes.
  const once = scenario.writes
    .slice(0, reachable)
    .filter(
      (tag) => [OrderState.Idle._tag, ...scenario.writes].filter((t) => t === tag).length === 1,
    );
  for (const tag of once) starts.push(afterMatch(tag));
  // Entry effects that send would write past the held permit's write.
  const stoppable = !scenario.restarts && scenario !== brief && scenario !== chain;
  if (stoppable && form.sendsItself) starts.push(stopInGap(driverCount));
  if (stoppable && !form.sendsItself) {
    for (let i = 0; i < driverCount; i += 1) starts.push(stopInGap(i));
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

// The time limits only make a hang visible as a test failure; the waits under test have none.
const run = ({ form, scenario, predicate, start }: Case) =>
  Effect.gen(function* () {
    const actor = yield* scenario.spawn;
    const recorder = record(actor, scenario);
    yield* actor.start;
    recorder.log.push({ kind: "started" });
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
      driverSends: driverSendsOf(form, scenario),
      afterFirstCall: () => undefined,
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
    const driven = yield* start.drive(context).pipe(Effect.timeoutOption("1 second"));
    if (Option.isNone(driven)) {
      yield* actor.stop;
      const stuck: Run = {
        log: [...recorder.log],
        calls,
        reentered,
        outcome: "the harness did not reach the start point",
        actorFinished: true,
      };
      return stuck;
    }
    const waiting = driven.value;
    const finished = yield* actor.awaitExit.pipe(Effect.timeoutOption("2 seconds"));
    if (Option.isNone(finished)) yield* actor.stop;
    const settled = yield* Fiber.await(waiting).pipe(Effect.timeoutOption("100 millis"));
    if (Option.isNone(settled)) yield* Fiber.interrupt(waiting);
    const outcome = Option.match(settled, {
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
    } satisfies Run;
  });

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
      const call = indexOf(result.log, (entry) => entry.kind === "call");
      if (writesIn(result.log.slice(call, start)).length > 0) kinds.push("observed after its send");
    }
    if (testCase.form.takesPredicate && result.calls.join(">") !== expected.calls.join(">")) {
      kinds.push("calls differ from the write log");
    }
    if (result.outcome !== expected.outcome) kinds.push("wrong outcome");
  }
  if (result.reentered) kinds.push("a predicate call started inside another");
  if (!result.actorFinished) kinds.push("the actor did not finish");
  if (!testCase.start.reached(result.log)) kinds.push("the start point was not reached");
  // A form that sends from inside a notification puts its event before the harness's later
  // ones, so only runs where the form's event is the only one keep the declared writes.
  const fullRun =
    !testCase.predicate.sends &&
    testCase.start.family !== stopInGap(0).family &&
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
    detail: `expected calls=${expected.calls.join(">")} outcome=${expected.outcome}; got calls=${result.calls.join(">")} outcome=${result.outcome}; writes=${writesIn(result.log).join(">")}`,
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
  let scenarios = [...racingScenarios, ...restartScenarios];
  if (form.sendsItself) scenarios = sendingScenarios;
  return scenarios.flatMap((scenario) =>
    predicatesFor(form).flatMap((predicate) =>
      schedules.map((schedule) => ({ form, scenario, predicate, start: race(schedule) })),
    ),
  );
};

const positionCases = (form: Form): ReadonlyArray<Case> =>
  [...racingScenarios, ...restartScenarios].flatMap((scenario) =>
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

/** Check every case. With racing writes and a predicate, also prove some runs start first. */
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
      `${form.name}, from every other start point`,
      () => checkProperty(positionCases(form)),
      300_000,
    );
  }
});
