// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Fiber, Schema, SubscriptionRef } from "effect";

import { ActorSystemDefault, ActorSystemService, Machine, State, Event } from "../src/index.js";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

const ConnState = State({
  Connecting: {},
  Connected: {},
  Failed: {},
});

const ConnEvent = Event({
  Connected: {},
  Data: { payload: Schema.String },
  Failed: {},
});

describe(".postpone()", () => {
  it.scopedLive("postponed events are redelivered after state change", () =>
    Effect.gen(function* () {
      const received: string[] = [];

      const machine = Machine.make({
        state: ConnState,
        event: ConnEvent,
        initial: ConnState.Connecting,
      })
        .on(ConnState.Connecting, ConnEvent.Connected, () => ConnState.Connected)
        .on(ConnState.Connecting, ConnEvent.Failed, () => ConnState.Failed)
        .on(ConnState.Connected, ConnEvent.Data, ({ event }) => {
          received.push(event.payload);
          return ConnState.Connected;
        })
        .postpone(ConnState.Connecting, ConnEvent.Data)
        .final(ConnState.Failed)
        .build();

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Send data while connecting — should be postponed
      yield* actor.send(ConnEvent.Data({ payload: "first" }));
      yield* actor.send(ConnEvent.Data({ payload: "second" }));
      yield* yieldFibers;

      // No data processed yet
      expect(received).toEqual([]);
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Connecting");

      // Transition to Connected — postponed events should drain
      yield* actor.send(ConnEvent.Connected);
      yield* yieldFibers;

      expect(received).toEqual(["first", "second"]);
      expect((yield* SubscriptionRef.get(actor.state))._tag).toBe("Connected");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("postponed events maintain FIFO order", () =>
    Effect.gen(function* () {
      const order: string[] = [];

      const machine = Machine.make({
        state: ConnState,
        event: ConnEvent,
        initial: ConnState.Connecting,
      })
        .on(ConnState.Connecting, ConnEvent.Connected, () => ConnState.Connected)
        .on(ConnState.Connected, ConnEvent.Data, ({ event }) => {
          order.push(event.payload);
          return ConnState.Connected;
        })
        .postpone(ConnState.Connecting, ConnEvent.Data)
        .build();

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(ConnEvent.Data({ payload: "a" }));
      yield* actor.send(ConnEvent.Data({ payload: "b" }));
      yield* actor.send(ConnEvent.Data({ payload: "c" }));
      yield* yieldFibers;

      yield* actor.send(ConnEvent.Connected);
      yield* yieldFibers;

      expect(order).toEqual(["a", "b", "c"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("non-postponed events are processed normally", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: ConnState,
        event: ConnEvent,
        initial: ConnState.Connecting,
      })
        .on(ConnState.Connecting, ConnEvent.Connected, () => ConnState.Connected)
        .on(ConnState.Connecting, ConnEvent.Failed, () => ConnState.Failed)
        .postpone(ConnState.Connecting, ConnEvent.Data)
        .final(ConnState.Failed)
        .build();

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Failed is not postponed — processes immediately
      const r = yield* actor.call(ConnEvent.Failed);
      expect(r.newState._tag).toBe("Failed");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("call returns postponed: true for postponed events", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: ConnState,
        event: ConnEvent,
        initial: ConnState.Connecting,
      })
        .on(ConnState.Connecting, ConnEvent.Connected, () => ConnState.Connected)
        .on(ConnState.Connected, ConnEvent.Data, () => ConnState.Connected)
        .postpone(ConnState.Connecting, ConnEvent.Data)
        .build();

      const actor = yield* Machine.spawn(machine);

      // call on postponed event returns immediately with postponed: true
      const result = yield* actor.call(ConnEvent.Data({ payload: "x" }));
      expect(result.postponed).toBe(true);
      expect(result.transitioned).toBe(false);
    }),
  );

  it.scopedLive("multiple events can be postponed", () =>
    Effect.gen(function* () {
      const MState = State({
        Init: {},
        Ready: {},
      });

      const MEvent = Event({
        Start: {},
        Alpha: {},
        Beta: {},
      });

      const received: string[] = [];

      const machine = Machine.make({
        state: MState,
        event: MEvent,
        initial: MState.Init,
      })
        .on(MState.Init, MEvent.Start, () => MState.Ready)
        .on(MState.Ready, MEvent.Alpha, () => {
          received.push("alpha");
          return MState.Ready;
        })
        .on(MState.Ready, MEvent.Beta, () => {
          received.push("beta");
          return MState.Ready;
        })
        .postpone(MState.Init, [MEvent.Alpha, MEvent.Beta])
        .build();

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      yield* actor.send(MEvent.Alpha);
      yield* actor.send(MEvent.Beta);
      yield* yieldFibers;

      expect(received).toEqual([]);

      yield* actor.send(MEvent.Start);
      yield* yieldFibers;

      expect(received).toEqual(["alpha", "beta"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("postponed events have priority over later mailbox arrivals", () =>
    Effect.gen(function* () {
      const order: string[] = [];

      const PState = State({
        Init: {},
        Ready: {},
      });
      const PEvent = Event({
        Go: {},
        Data: { payload: Schema.String },
        Ack: {},
      });

      const machine = Machine.make({
        state: PState,
        event: PEvent,
        initial: PState.Init,
      })
        .on(PState.Init, PEvent.Go, () => PState.Ready)
        .on(PState.Ready, PEvent.Data, ({ event }) => {
          order.push(`data:${event.payload}`);
          return PState.Ready;
        })
        .on(PState.Ready, PEvent.Ack, () => {
          order.push("ack");
          return PState.Ready;
        })
        .postpone(PState.Init, PEvent.Data)
        .build();

      const system = yield* ActorSystemService;
      const actor = yield* system.spawn("test", machine);

      // Data is postponed in Init state
      yield* actor.send(PEvent.Data({ payload: "a" }));
      yield* yieldFibers;

      // Go transitions to Ready — Data should drain BEFORE Ack
      yield* actor.send(PEvent.Go);
      yield* actor.send(PEvent.Ack);
      yield* yieldFibers;

      // Postponed Data should run before Ack
      expect(order).toEqual(["data:a", "ack"]);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scopedLive("postponed ask events settled on stop", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: ConnState,
        event: ConnEvent,
        initial: ConnState.Connecting,
      })
        .on(ConnState.Connecting, ConnEvent.Connected, () => ConnState.Connected)
        .on(ConnState.Connected, ConnEvent.Data, () => ConnState.Connected)
        .postpone(ConnState.Connecting, ConnEvent.Data)
        .build();

      const actor = yield* Machine.spawn(machine);

      // ask will block until event is processed — but we stop before that
      const fiber = yield* actor
        .ask(ConnEvent.Data({ payload: "x" }))
        .pipe(Effect.result, Effect.forkChild);

      yield* yieldFibers;
      yield* actor.stop;
      yield* yieldFibers;

      const result = yield* Fiber.join(fiber);
      expect(result._tag).toBe("Failure");
    }),
  );
});
