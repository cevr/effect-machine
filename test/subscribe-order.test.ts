// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Context, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect";
import type { Semaphore } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { ActorSystemDefault, Event, Machine, State, Supervision } from "../src/index.js";

// Property: a state observer receives the states written after it subscribes, in write order,
// each once, and nothing after it unsubscribes or after the final state. So what it receives is
// a prefix of the writes since its subscription, and all of them while it stays subscribed. This
// holds for `subscribe` listeners (also when one sends, subscribes, unsubscribes or throws from
// its callback) and for the `changes` stream (which starts with the state held at subscription).
//
// Oracle: the harness records every write of the actor's state ref (an accessor on the field
// that `SubscriptionRef` writes), and the moment each observer subscribes and unsubscribes. The
// actor never reads this log. The expected states of an observer are the writes between its
// subscription and its unsubscription. Nothing in the oracle comes from what the observers got.

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
  /** Events the harness sends once, after the observers under test subscribe. */
  readonly sends: readonly [EventTag, ...Array<EventTag>];
  /** An event the harness listener sends at its first receipt of a state. */
  readonly gate?: { readonly event: EventTag; readonly on: Tag };
  /** Every write after the harness starts recording, in a run where no observer sends. */
  readonly writes: ReadonlyArray<Tag>;
  /** How many of `writes` `actor.start` causes. */
  readonly startupWrites: number;
  /** A supervised restart writes state outside the event loop's write-then-notify order. */
  readonly restarts: boolean;
  /** Entry effects do not send, so a held permit stops the loop right after one write. */
  readonly stoppable: boolean;
}

const plain = (
  name: string,
  machine: OrderMachine,
  sends: readonly [EventTag, ...Array<EventTag>],
  writes: ReadonlyArray<Tag>,
  stoppable: boolean,
): Scenario => ({
  name,
  spawn: spawnOrder(machine),
  sends,
  writes,
  startupWrites: 0,
  restarts: false,
  stoppable,
});

const sentShort = plain(
  "test sends Work,Finish",
  makeMachine(),
  ["Work", "Finish"],
  ["Working", "Done"],
  true,
);
const sentLong = plain(
  "test sends Work,Next,Finish",
  makeMachine(),
  ["Work", "Next", "Finish"],
  ["Working", "Other", "Done"],
  true,
);
const brief = plain(
  "Working sends Finish",
  makeMachine().spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Finish)),
  ["Work"],
  ["Working", "Done"],
  false,
);
const chain = plain(
  "Working sends Next, Other sends Finish",
  makeMachine()
    .spawn(OrderState.Working, ({ self }) => self.send(OrderEvent.Next))
    .spawn(OrderState.Other, ({ self }) => self.send(OrderEvent.Finish)),
  ["Work"],
  ["Working", "Other", "Done"],
  false,
);
const ping = plain(
  "test sends Work,Ping,Finish (Ping rewrites the same object)",
  makeMachine(),
  ["Work", "Ping", "Finish"],
  ["Working", "Working", "Done"],
  true,
);
// N3: Working is written, its entry crashes before the notification, and the restart writes
// Idle over it.
const restartCrash: Scenario = {
  name: "Working's entry crashes, the actor restarts",
  spawn: spawnRestarting((machine) => machine),
  sends: ["Work"],
  gate: { event: "Finish", on: "Idle" },
  writes: ["Working", "Idle", "Done"],
  startupWrites: 0,
  restarts: true,
  stoppable: false,
};
// N2: the restart writes Idle, the new generation writes and notifies Ready, then the restart
// notifies Idle.
const restartStale: Scenario = {
  name: "Ready's Working entry crashes, the restart notifies late",
  spawn: spawnRestarting((machine) =>
    machine
      .immediate(OrderState.Idle, () => OrderState.Ready)
      .on(OrderState.Ready, OrderEvent.Work, () => OrderState.Working),
  ),
  sends: ["Work"],
  gate: { event: "Finish", on: "Idle" },
  writes: ["Ready", "Working", "Idle", "Ready", "Done"],
  startupWrites: 1,
  restarts: true,
  stoppable: false,
};

const scenarios = [sentShort, sentLong, brief, chain, ping, restartCrash, restartStale];

// ---------------------------------------------------------------------------
// The write log
// ---------------------------------------------------------------------------

type Entry =
  | { readonly kind: "write"; readonly tag: Tag }
  | { readonly kind: "subscribe"; readonly observer: string }
  | { readonly kind: "unsubscribe"; readonly observer: string }
  | {
      readonly kind: "receive";
      readonly observer: string;
      readonly tag: Tag;
      /** The observer's callback for an earlier state had not returned. */
      readonly nested: boolean;
    }
  /** `actor.start` returned. */
  | { readonly kind: "started" };

/** Marks the fiber of the `changes` consumer, so the log can tell its subscription apart. */
const UnderTest = Context.Reference<boolean>("effect-machine/test/subscribe-order/UnderTest", {
  defaultValue: () => false,
});
const inObserverUnderTest = (): boolean => Fiber.getCurrent()?.getRef(UnderTest) === true;

interface Recorder {
  readonly actor: OrderActor;
  readonly log: Array<Entry>;
  /** Writes since recording started, without the state held then. */
  readonly writes: () => number;
  /** Unsubscribe functions of the `subscribe` observers, by name. */
  readonly unsubscribers: Map<string, () => void>;
  /** Runs inside the write, before it is published: it must not touch the actor. */
  onWrite: (index: number) => void;
  /** Runs in the harness listener's callback, at its receipt `index`. */
  onHarness: (index: number) => void;
}

const writesIn = (entries: ReadonlyArray<Entry>): ReadonlyArray<Tag> =>
  entries.flatMap((entry) => {
    if (entry.kind === "write") return [entry.tag];
    return [];
  });
const receiptsOf = (entries: ReadonlyArray<Entry>, observer: string): ReadonlyArray<Tag> =>
  entries.flatMap((entry) => {
    if (entry.kind === "receive" && entry.observer === observer) return [entry.tag];
    return [];
  });
const indexOf = (log: ReadonlyArray<Entry>, match: (entry: Entry) => boolean): number =>
  log.findIndex(match);
const subscribedAt = (log: ReadonlyArray<Entry>, observer: string): number =>
  indexOf(log, (entry) => entry.kind === "subscribe" && entry.observer === observer);

/**
 * A `subscribe` observer named `name`. `act` runs in its callback with the receipt count. A
 * listener that throws throws after it logged the receipt.
 */
const listen = (
  recorder: Recorder,
  name: string,
  act: (received: number) => void = () => undefined,
  throws = false,
): void => {
  let received = 0;
  let depth = 0;
  recorder.log.push({ kind: "subscribe", observer: name });
  const unsubscribe = recorder.actor.subscribe((state) => {
    received += 1;
    recorder.log.push({ kind: "receive", observer: name, tag: state._tag, nested: depth > 0 });
    depth += 1;
    act(received);
    depth -= 1;
    // This host callback must throw to test listener isolation.
    // eslint-disable-next-line effect/noThrowStatement, effect/noNewError
    if (throws) throw new Error("listener defect");
  });
  recorder.unsubscribers.set(name, () => {
    recorder.log.push({ kind: "unsubscribe", observer: name });
    unsubscribe();
  });
};

/**
 * Instrument the actor's state ref before it starts. The accessor sees every write, because
 * `SubscriptionRef` stores the value in this field. The publication's `replayWindow` runs once
 * per subscription, right after it registers, which marks the `changes` consumer's start. The
 * harness listener "H" subscribes first and is an observer under test too.
 */
const record = (actor: OrderActor, scenario: Scenario): Recorder => {
  const recorder: Recorder = {
    actor,
    log: [],
    writes: () => writesIn(recorder.log).length - 1,
    unsubscribers: new Map(),
    onWrite: () => undefined,
    onHarness: () => undefined,
  };
  const ref = actor.state;
  let value = ref.value;
  recorder.log.push({ kind: "write", tag: value._tag });
  Object.defineProperty(ref, "value", {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next: OrderState) => {
      value = next;
      recorder.log.push({ kind: "write", tag: next._tag });
      recorder.onWrite(recorder.writes());
    },
  });
  const atomic = ref.pubsub.pubsub;
  const replayWindow = atomic.replayWindow.bind(atomic);
  let changesSubscribed = false;
  atomic.replayWindow = () => {
    const window = replayWindow();
    if (!changesSubscribed && inObserverUnderTest()) {
      changesSubscribed = true;
      recorder.log.push({ kind: "subscribe", observer: "changes" });
    }
    return window;
  };
  let gate = scenario.gate;
  listen(recorder, "H", (index) => {
    recorder.onHarness(index);
    if (gate !== undefined && gate.on === receiptsOf(recorder.log, "H").at(-1)) {
      const event = gate.event;
      gate = undefined;
      actor.client.send(eventOf[event]);
    }
  });
  return recorder;
};

// ---------------------------------------------------------------------------
// Observers and what their callbacks do
// ---------------------------------------------------------------------------

interface Behavior {
  readonly name: string;
  /** The callback sends events, so the writes differ from the scenario's. */
  readonly sends: boolean;
  readonly throws: boolean;
  readonly act: (recorder: Recorder, received: number) => void;
}

const quiet: Behavior = { name: "quiet", sends: false, throws: false, act: () => undefined };
const sendsAt = (n: number, event: EventTag): Behavior => ({
  name: `sends ${event} at receipt ${n}`,
  sends: true,
  throws: false,
  act: (recorder, received) => {
    if (received === n) recorder.actor.client.send(eventOf[event]);
  },
});
const subscribesAt = (n: number): Behavior => ({
  name: `subscribes C at receipt ${n}`,
  sends: false,
  throws: false,
  act: (recorder, received) => {
    if (received === n) listen(recorder, "C");
  },
});
const unsubscribesAt = (n: number, observer: "A" | "B"): Behavior => ({
  name: `unsubscribes ${observer} at receipt ${n}`,
  sends: false,
  throws: false,
  act: (recorder, received) => {
    if (received === n) recorder.unsubscribers.get(observer)?.();
  },
});
const throwing: Behavior = { name: "throws", sends: false, throws: true, act: () => undefined };

const firstBehaviors: ReadonlyArray<Behavior> = [
  quiet,
  sendsAt(1, "Next"),
  sendsAt(1, "Ping"),
  sendsAt(1, "Finish"),
  sendsAt(2, "Finish"),
  subscribesAt(1),
  subscribesAt(2),
  unsubscribesAt(1, "B"),
  unsubscribesAt(2, "B"),
  unsubscribesAt(1, "A"),
  throwing,
];
const secondBehaviors: ReadonlyArray<Behavior> = [quiet, sendsAt(1, "Finish")];

interface Observers {
  readonly name: string;
  readonly sends: boolean;
  /** Subscribe the observers under test, synchronously or by forking their consumer. */
  readonly subscribe: (recorder: Recorder) => void;
  /** The `changes` consumer, when there is one: the run waits for it, then interrupts it. */
  readonly consumer: { current: Fiber.Fiber<void> | undefined };
}

/** Listener A, then listener B, each with its own behavior. */
const listeners = (first: Behavior, second: Behavior): Observers => ({
  name: `A ${first.name}, B ${second.name}`,
  sends: first.sends || second.sends,
  subscribe: (recorder) => {
    listen(recorder, "A", (received) => first.act(recorder, received), first.throws);
    listen(recorder, "B", (received) => second.act(recorder, received), second.throws);
  },
  consumer: { current: undefined },
});

/** A consumer of `actor.changes`. Its subscription point comes from the publication. */
const changes = (): Observers => {
  const consumer: { current: Fiber.Fiber<void> | undefined } = { current: undefined };
  return {
    name: "changes",
    sends: false,
    subscribe: (recorder) => {
      consumer.current = Effect.runFork(
        Stream.runForEach(recorder.actor.changes, (state) =>
          Effect.sync(() => {
            recorder.log.push({
              kind: "receive",
              observer: "changes",
              tag: state._tag,
              nested: false,
            });
          }),
        ).pipe(Effect.provideService(UnderTest, true)),
      );
    },
    consumer,
  };
};

// ---------------------------------------------------------------------------
// Start points
// ---------------------------------------------------------------------------

interface Start {
  readonly family: string;
  readonly value: number | string;
  /** Sends the scenario's events and subscribes the observers at the start point. */
  readonly drive: (
    recorder: Recorder,
    scenario: Scenario,
    observers: Observers,
  ) => Effect.Effect<void>;
  /** Whether the run reached the window this start point names. */
  readonly reached: (log: ReadonlyArray<Entry>) => boolean;
  /** `subscribe` observers only: the consumer of `changes` starts later than the call. */
  readonly listenersOnly: boolean;
}

const sendAll = (actor: OrderActor, events: ReadonlyArray<EventTag>): void => {
  for (const event of events) actor.client.send(eventOf[event]);
};
const signal = (deferred: Deferred.Deferred<void>): void => {
  Deferred.doneUnsafe(deferred, Exit.void);
};
// A synchronous step inside a listener callback, where no fiber can be suspended.
const holdPermit = (permit: Semaphore.Semaphore): void => {
  Effect.runSync(permit.take(1));
};
const firstSubscription = (log: ReadonlyArray<Entry>): number =>
  indexOf(log, (entry) => entry.kind === "subscribe" && entry.observer !== "H");

/** The observers subscribe before the writes. */
const before: Start = {
  family: "before the writes",
  value: 0,
  drive: (recorder, scenario, observers) =>
    Effect.sync(() => {
      observers.subscribe(recorder);
      sendAll(recorder.actor, scenario.sends);
    }),
  reached: () => true,
  listenersOnly: false,
};

/** The observers subscribe after `turns` scheduler turns, while the writes run. */
const race = (turns: number): Start => ({
  family: "after scheduler turns",
  value: turns,
  drive: (recorder, scenario, observers) =>
    Effect.gen(function* () {
      const subscribed = Deferred.makeUnsafe<void>();
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          for (let turn = 0; turn < turns; turn += 1) yield* Effect.yieldNow;
          observers.subscribe(recorder);
          signal(subscribed);
        }),
      );
      sendAll(recorder.actor, scenario.sends);
      yield* Deferred.await(subscribed);
    }),
  reached: () => true,
  listenersOnly: false,
});

/**
 * The listeners subscribe after write `k` and before its notification. The loop writes the
 * state, then needs the `latestTransition` permit before it notifies, so the harness holds it.
 */
const gap = (k: number): Start => ({
  family: "between write and notification",
  value: k,
  drive: (recorder, scenario, observers) =>
    Effect.gen(function* () {
      const permit = recorder.actor.latestTransition.semaphore;
      const written = Deferred.makeUnsafe<void>();
      const writesBefore = recorder.writes();
      if (k === writesBefore + 1) yield* permit.take(1);
      recorder.onHarness = (index) => {
        if (index === k - 1) holdPermit(permit);
      };
      recorder.onWrite = (index) => {
        if (index === k) signal(written);
      };
      sendAll(recorder.actor, scenario.sends);
      yield* Deferred.await(written);
      observers.subscribe(recorder);
      yield* permit.release(1);
    }),
  reached: (log) => {
    const start = firstSubscription(log);
    return start !== -1 && writesIn(log.slice(0, start)).length === k + 1;
  },
  listenersOnly: true,
});

/** The listeners subscribe from the harness listener's callback, at its receipt `j`. */
const inNotification = (j: number): Start => ({
  family: "inside a notification",
  value: j,
  drive: (recorder, scenario, observers) =>
    Effect.gen(function* () {
      const reached = Deferred.makeUnsafe<void>();
      recorder.onHarness = (index) => {
        if (index !== j) return;
        observers.subscribe(recorder);
        signal(reached);
      };
      sendAll(recorder.actor, scenario.sends);
      yield* Deferred.await(reached);
    }),
  reached: (log) => {
    const start = firstSubscription(log);
    const previous = log[start - 1];
    return (
      start > 0 &&
      previous?.kind === "receive" &&
      previous.observer === "H" &&
      receiptsOf(log.slice(0, start), "H").length === j
    );
  },
  listenersOnly: true,
});

/** The listeners subscribe in the same fiber, right after a `waitFor` matched `tag`. */
const afterMatch = (tag: Tag): Start => ({
  family: "after a wait matched",
  value: tag,
  drive: (recorder, scenario, observers) =>
    Effect.gen(function* () {
      const called = Deferred.makeUnsafe<void>();
      const matched = yield* recorder.actor
        .waitFor((state) => {
          signal(called);
          return state._tag === tag;
        })
        .pipe(
          Effect.andThen(Effect.sync(() => observers.subscribe(recorder))),
          Effect.exit,
          Effect.forkDetach,
        );
      yield* Deferred.await(called);
      // Let the wait settle on its snapshot before the writes.
      yield* Effect.yieldNow;
      sendAll(recorder.actor, scenario.sends);
      yield* Fiber.await(matched);
    }),
  reached: (log) => {
    const start = firstSubscription(log);
    return start !== -1 && writesIn(log.slice(0, start)).includes(tag);
  },
  listenersOnly: true,
});

/**
 * The listeners subscribe after events `[0, i)` settled. Then event `i` is written, and the
 * actor stops before it notifies that write (the harness holds the `latestTransition` permit).
 */
const stopInGap = (i: number): Start => ({
  family: "stop before the notification of event",
  value: i,
  drive: (recorder, scenario, observers) =>
    Effect.gen(function* () {
      for (const event of scenario.sends.slice(0, i)) {
        yield* recorder.actor.call(eventOf[event]);
      }
      const permit = recorder.actor.latestTransition.semaphore;
      yield* permit.take(1);
      const written = Deferred.makeUnsafe<void>();
      const writesBefore = recorder.writes();
      recorder.onWrite = (index) => {
        if (index === writesBefore + 1) signal(written);
      };
      observers.subscribe(recorder);
      recorder.actor.client.send(eventOf[scenario.sends[i]!]);
      yield* Deferred.await(written);
      yield* recorder.actor.stop.pipe(Effect.forkDetach);
      yield* recorder.actor.awaitExit.pipe(
        Effect.timeoutOption("1 second"),
        Effect.andThen(permit.release(1)),
      );
    }),
  reached: (log) => {
    const start = firstSubscription(log);
    return start !== -1 && writesIn(log.slice(start)).length >= 1;
  },
  listenersOnly: true,
});

const startsFor = (scenario: Scenario): ReadonlyArray<Start> => {
  const starts: Array<Start> = [before];
  for (let turns = 0; turns <= 12; turns += 1) starts.push(race(turns));
  const total = scenario.writes.length;
  for (let k = scenario.startupWrites + 1; k <= total; k += 1) {
    if (!scenario.restarts) starts.push(gap(k));
  }
  // A restart delivers its writes in a different number of notifications on the base code.
  let notified = total;
  if (scenario.restarts) notified = scenario.startupWrites + 2;
  for (let j = scenario.startupWrites + 1; j <= notified; j += 1) starts.push(inNotification(j));
  const once = scenario.writes.filter(
    (tag) => [OrderState.Idle._tag, ...scenario.writes].filter((t) => t === tag).length === 1,
  );
  for (const tag of once) starts.push(afterMatch(tag));
  if (scenario.stoppable) {
    for (let i = 0; i < scenario.sends.length; i += 1) starts.push(stopInGap(i));
  }
  return starts;
};

// ---------------------------------------------------------------------------
// Runs and their judgement
// ---------------------------------------------------------------------------

interface Case {
  readonly scenario: Scenario;
  readonly observers: () => Observers;
  readonly start: Start;
}

interface Run {
  readonly log: ReadonlyArray<Entry>;
  readonly outcome: string;
  readonly sends: boolean;
}

// The time limits only make a hang visible as a test failure.
const run = ({ scenario, observers: makeObservers, start }: Case) =>
  Effect.gen(function* () {
    const observers = makeObservers();
    const actor = yield* scenario.spawn;
    const recorder = record(actor, scenario);
    yield* actor.start;
    recorder.log.push({ kind: "started" });
    const driven = yield* start
      .drive(recorder, scenario, observers)
      .pipe(Effect.timeoutOption("1 second"));
    let outcome = "finished";
    if (Option.isNone(driven)) outcome = "the harness did not reach the start point";
    const finished = yield* actor.awaitExit.pipe(Effect.timeoutOption("2 seconds"));
    if (Option.isNone(finished)) {
      yield* actor.stop;
      if (Option.isSome(driven)) outcome = "the actor did not finish";
    }
    const consumer = observers.consumer.current;
    if (consumer !== undefined) {
      // The stream delivers on its own fiber: give it time to catch up, then end it.
      yield* Effect.sleep("20 millis");
      yield* Fiber.interrupt(consumer);
    }
    return { log: [...recorder.log], outcome, sends: observers.sends } satisfies Run;
  });

interface Violation {
  readonly kind: string;
  /** The case without its position, so one line lists every position that breaks it. */
  readonly group: string;
  readonly start: Start;
  readonly detail: string;
}

/** What one observer should have received, from the write log alone. */
const expectedFor = (log: ReadonlyArray<Entry>, observer: string) => {
  const from = subscribedAt(log, observer);
  const until = indexOf(
    log,
    (entry) => entry.kind === "unsubscribe" && entry.observer === observer,
  );
  let end = until;
  if (until === -1) end = log.length;
  const writes = writesIn(log.slice(from, end));
  // `changes` starts with the state held when it subscribed.
  if (observer === "changes") return [writesIn(log.slice(0, from)).at(-1)!, ...writes];
  return writes;
};

const isPrefix = (got: ReadonlyArray<Tag>, expected: ReadonlyArray<Tag>): boolean =>
  got.length <= expected.length && got.every((tag, index) => expected[index] === tag);

/** Judge one run against its log. */
const judgeRun = (testCase: Case, result: Run): Violation | undefined => {
  const kinds: Array<string> = [];
  const details: Array<string> = [];
  const observers = [
    ...new Set(
      result.log.flatMap((entry) => {
        if (entry.kind === "subscribe") return [entry.observer];
        return [];
      }),
    ),
  ];
  for (const observer of observers) {
    const expected = expectedFor(result.log, observer);
    const got = receiptsOf(result.log, observer);
    const unsubscribed = indexOf(
      result.log,
      (entry) => entry.kind === "unsubscribe" && entry.observer === observer,
    );
    if (!isPrefix(got, expected)) kinds.push(`${observer} got states out of write order`);
    else if (unsubscribed === -1 && got.length < expected.length) {
      kinds.push(`${observer} missed a write`);
    }
    if (
      unsubscribed !== -1 &&
      result.log
        .slice(unsubscribed)
        .some((entry) => entry.kind === "receive" && entry.observer === observer)
    ) {
      kinds.push(`${observer} got a state after it unsubscribed`);
    }
    if (
      result.log.some(
        (entry) => entry.kind === "receive" && entry.observer === observer && entry.nested,
      )
    ) {
      kinds.push(`${observer}'s callback started inside its own callback`);
    }
    details.push(`${observer}: expected ${expected.join(">")}, got ${got.join(">")}`);
  }
  if (result.outcome !== "finished") kinds.push(result.outcome);
  if (!testCase.start.reached(result.log)) kinds.push("the start point was not reached");
  if (
    !result.sends &&
    testCase.start.family !== stopInGap(0).family &&
    writesIn(result.log).slice(1).join(">") !== testCase.scenario.writes.join(">")
  ) {
    kinds.push("the writes differ from the scenario");
  }
  if (kinds.length === 0) return undefined;
  const kind = [...new Set(kinds)].join(", ");
  return {
    kind,
    group: `${kind}: ${testCase.observers().name} | ${testCase.scenario.name} | ${testCase.start.family}`,
    start: testCase.start,
    detail: `${details.join("; ")}; writes=${writesIn(result.log).join(">")}`,
  };
};

const runCase = (testCase: Case) =>
  run(testCase).pipe(
    Effect.map((result) => ({ violation: judgeRun(testCase, result), result })),
    Effect.provide(ActorSystemDefault),
  );

const listenerCases = (first: Behavior): ReadonlyArray<Case> =>
  scenarios.flatMap((scenario) =>
    secondBehaviors.flatMap((second) =>
      startsFor(scenario).map((start) => ({
        scenario,
        observers: () => listeners(first, second),
        start,
      })),
    ),
  );

const changesCases: ReadonlyArray<Case> = scenarios.flatMap((scenario) =>
  startsFor(scenario)
    .filter(({ listenersOnly }) => !listenersOnly)
    .map((start) => ({ scenario, observers: changes, start })),
);

/** "after scheduler turns 0-12; inside a notification 1,2" */
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
  });

/**
 * Counterexamples, each red on the code named in its title. Each also asserts that it reaches
 * its start point. The properties own the class.
 */
const quietPair = () => listeners(quiet, quiet);
const namedCases: ReadonlyArray<readonly [string, Case]> = [
  [
    "N2: a restart's late notification is not delivered after newer states (red on 1469452)",
    { scenario: restartStale, observers: quietPair, start: before },
  ],
  [
    "N3: a write whose entry crashes comes before the restart's write, and a send from a callback does not re-enter it (red on 1469452)",
    { scenario: restartCrash, observers: quietPair, start: before },
  ],
  [
    "GAP: a listener that subscribes between a write and its notification does not get that write (red on 1469452)",
    { scenario: sentShort, observers: quietPair, start: gap(1) },
  ],
  [
    "NESTED-SUB: a listener that subscribes from a callback does not get the state being delivered (red on 1469452)",
    { scenario: sentShort, observers: quietPair, start: inNotification(1) },
  ],
  [
    "NESTED-SUB: a listener that a listener subscribes does not get the state being delivered (red on 1469452)",
    { scenario: sentShort, observers: () => listeners(subscribesAt(1), quiet), start: before },
  ],
  [
    "a listener that subscribes right after a wait matched does not get the matched state (red on 1469452)",
    { scenario: sentShort, observers: quietPair, start: afterMatch("Working") },
  ],
  [
    "IDENTITY: a rewrite of the same object that a stop overtakes is delivered (red on 1469452)",
    { scenario: ping, observers: quietPair, start: stopInGap(1) },
  ],
  [
    "a write whose notification a stop overtakes is delivered (red on 1469452)",
    { scenario: sentShort, observers: quietPair, start: stopInGap(0) },
  ],
];

describe("a state observer receives the writes since it subscribed, in order, once", () => {
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
  for (const first of firstBehaviors) {
    it.live(`subscribe: A ${first.name}`, () => checkProperty(listenerCases(first)), 300_000);
  }
  it.live("changes", () => checkProperty(changesCases), 300_000);
});
