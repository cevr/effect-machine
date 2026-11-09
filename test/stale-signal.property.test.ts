// @effect-diagnostics strictEffectProvide:off - tests are entry points
// Seeded property: over generated interleavings of reentries, round trips,
// same-tag updates, slow transition handlers, task completions and clock steps,
// every task result and every fired timeout that a handler sees comes from the
// state entry that is current when it is processed. The current entry's own
// signals still arrive. The seeds are fixed, so a failure replays exactly.
import { Deferred, Duration, Effect, Schema } from "effect";
import { TestClock } from "effect/testing";

import { Event, Machine, State } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const S = State({
  Active: { entry: Schema.Finite, edits: Schema.Finite },
  Away: { entry: Schema.Finite },
});

const E = Event({
  Kick: {},
  SlowKick: {},
  Leave: {},
  SlowLeave: {},
  Back: {},
  Edit: {},
  Result: { entry: Schema.Finite },
  Failed: { entry: Schema.Finite },
  Timeout: { entry: Schema.Finite },
});

type Step =
  | {
      readonly _tag: "send";
      readonly event: "Kick" | "SlowKick" | "Leave" | "SlowLeave" | "Back" | "Edit";
    }
  | { readonly _tag: "open"; readonly entry: number }
  | { readonly _tag: "tick"; readonly millis: number };

/** mulberry32: a small seeded PRNG, so a failing seed replays exactly. */
const prng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const sendEvents = ["Kick", "SlowKick", "Leave", "SlowLeave", "Back", "Edit"] as const;
const ticks = [250, 1000, 3000] as const;

const generate = (seed: number): ReadonlyArray<Step> => {
  const next = prng(seed);
  const pick = <A>(values: ReadonlyArray<A>): A => values[Math.floor(next() * values.length)]!;
  const length = 6 + Math.floor(next() * 20);
  const steps: Step[] = [];
  let entries = 1;
  for (let i = 0; i < length; i++) {
    const roll = next();
    if (roll < 0.45) {
      const event = pick(sendEvents);
      if (event === "Kick" || event === "SlowKick" || event === "Back") entries += 1;
      steps.push({ _tag: "send", event });
    } else if (roll < 0.75) {
      steps.push({ _tag: "open", entry: Math.floor(next() * entries) });
    } else {
      steps.push({ _tag: "tick", millis: pick(ticks) });
    }
  }
  return steps;
};

const describeStep = (step: Step): string => {
  if (step._tag === "send") return step.event;
  if (step._tag === "open") return `open(${step.entry})`;
  return `tick(${step.millis}ms)`;
};

interface Seen {
  readonly signal: "Result" | "Failed" | "Timeout";
  readonly eventEntry: number;
  readonly state: "Active" | "Away";
  readonly stateEntry: number;
}

const settle = Effect.gen(function* () {
  for (let i = 0; i < 4; i++) yield* yieldFibers;
});

const runOne = (seed: number) =>
  Effect.gen(function* () {
    const seen: Seen[] = [];
    const gates = new Map<number, Deferred.Deferred<void>>();
    const gate = (entry: number) => {
      let found = gates.get(entry);
      if (found === undefined) {
        found = Deferred.makeUnsafe<void>();
        gates.set(entry, found);
      }
      return found;
    };
    const record = (
      signal: Seen["signal"],
      eventEntry: number,
      state: { readonly _tag: Seen["state"]; readonly entry: number },
    ) => seen.push({ signal, eventEntry, state: state._tag, stateEntry: state.entry });

    let nextEntry = 1;
    const fresh = () => nextEntry++;
    const slow = Duration.seconds(1);
    const machine = Machine.make({ state: S, event: E, initial: S.Active({ entry: 0, edits: 0 }) })
      .reenter(S.Active, E.Kick, () => S.Active({ entry: fresh(), edits: 0 }))
      .reenter(S.Active, E.SlowKick, () =>
        Effect.sleep(slow).pipe(Effect.as(S.Active({ entry: fresh(), edits: 0 }))),
      )
      .on(S.Active, E.Leave, ({ state }) => S.Away({ entry: state.entry }))
      .on(S.Active, E.SlowLeave, ({ state }) =>
        Effect.sleep(slow).pipe(Effect.as(S.Away({ entry: state.entry }))),
      )
      .on(S.Away, E.Back, () => S.Active({ entry: fresh(), edits: 0 }))
      // A same-tag `.on` keeps the entry: its signals must still arrive.
      .on(S.Active, E.Edit, ({ state }) => S.Active.with(state, { edits: state.edits + 1 }))
      .onAny(E.Result, ({ state, event }) => {
        record("Result", event.entry, state);
        return state;
      })
      .onAny(E.Failed, ({ state, event }) => {
        record("Failed", event.entry, state);
        return state;
      })
      .onAny(E.Timeout, ({ state, event }) => {
        record("Timeout", event.entry, state);
        return state;
      })
      .task(
        S.Active,
        ({ state }) =>
          Deferred.await(gate(state.entry)).pipe(
            Effect.andThen(() => {
              // Even entries succeed, odd entries fail: both handlers send owned events.
              if (state.entry % 2 === 0) return Effect.succeed(state.entry);
              return Effect.fail(state.entry);
            }),
          ),
        {
          onSuccess: (entry) => E.Result({ entry }),
          onFailure: (entry) => E.Failed({ entry }),
        },
      )
      .timeout(S.Active, {
        duration: Duration.seconds(3),
        event: (state) => E.Timeout({ entry: state.entry }),
      });

    const actor = yield* Machine.spawn(machine);
    yield* actor.start;
    yield* settle;

    const steps = generate(seed);
    for (const step of steps) {
      if (step._tag === "send") yield* actor.send(E[step.event]);
      else if (step._tag === "open") yield* Deferred.succeed(gate(step.entry), undefined);
      else yield* TestClock.adjust(Duration.millis(step.millis));
      yield* settle;
    }
    // Let slow handlers finish, then release the current entry's task.
    for (let i = 0; i < steps.length + 2; i++) {
      yield* TestClock.adjust(slow);
      yield* settle;
    }
    const last = yield* actor.snapshot;
    if (last._tag === "Active") {
      yield* Deferred.succeed(gate(last.entry), undefined);
      yield* settle;
    }
    yield* actor.stop;

    const context = `seed ${seed}: ${steps.map(describeStep).join(" ")}`;
    for (const signal of seen) {
      // Away runs no task and no timer, so every signal it sees is stale.
      let ownEntry = signal.stateEntry;
      if (signal.state === "Away") ownEntry = -1;
      expect({ context, ...signal, stateEntry: ownEntry }).toEqual({
        context,
        ...signal,
        stateEntry: signal.eventEntry,
      });
    }
    if (last._tag === "Active") {
      // The current entry's own task result arrives.
      const own = seen.filter(
        (signal) => signal.signal !== "Timeout" && signal.eventEntry === last.entry,
      );
      expect({ context, own: own.length }).toEqual({ context, own: 1 });
    }
  });

// Change these to replay a failing seed (the failure message names it).
// At the unfixed runtime, 45 of the 150 default seeds deliver a stale signal.
const runs = 150;
const firstSeed = 1;

describe("stale state-entry signals (property)", () => {
  it.scoped(`${runs} generated interleavings from seed ${firstSeed}`, () =>
    Effect.gen(function* () {
      for (let seed = firstSeed; seed < firstSeed + runs; seed++) {
        yield* Effect.scoped(runOne(seed));
      }
    }),
  );
});
