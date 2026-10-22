// @effect-diagnostics strictEffectProvide:off - tests are entry points
import { Effect, Schema } from "effect";
import { describe, expect, it, test } from "effect-bun-test";

import { Machine, State, Event } from "../src/index.js";

const CheckoutState = State({
  Browsing: {},
  Cart: { items: Schema.Finite },
  Paying: { items: Schema.Finite },
  Receipt: {},
  Cancelled: {},
});

const CheckoutEvent = Event({
  Add: {},
  Pay: {},
  Paid: {},
  Declined: {},
  Cancel: {},
  Timeout: {},
});

const hasItems = ({ state }: { readonly state: { readonly items: number } }): boolean =>
  state.items > 0;

function addItem({ state }: { readonly state: { readonly items: number } }) {
  return CheckoutState.Cart({ items: state.items + 1 });
}

const makeCheckout = () =>
  Machine.make({ state: CheckoutState, event: CheckoutEvent, initial: CheckoutState.Browsing })
    .on(CheckoutState.Browsing, CheckoutEvent.Add, function startCart() {
      return CheckoutState.Cart({ items: 1 });
    })
    .from(CheckoutState.Cart, (scope) =>
      scope
        .reenter(CheckoutEvent.Add, addItem)
        .when(CheckoutEvent.Pay, hasItems, ({ state }) =>
          CheckoutState.Paying({ items: state.items }),
        ),
    )
    .immediateWhen(
      CheckoutState.Cart,
      function isEmpty({ state }) {
        return state.items === 0;
      },
      () => CheckoutState.Browsing,
    )
    .on([CheckoutState.Cart, CheckoutState.Paying], CheckoutEvent.Cancel, function cancel() {
      return CheckoutState.Cancelled;
    })
    .task(CheckoutState.Paying, () => Effect.never, {
      onSuccess: () => CheckoutEvent.Paid,
      name: "charge",
    })
    .spawn(CheckoutState.Paying, function watchTerminal() {
      return Effect.void;
    })
    .timeout(CheckoutState.Paying, { duration: "2 minutes", event: CheckoutEvent.Timeout })
    .on(CheckoutState.Paying, CheckoutEvent.Paid, () => CheckoutState.Receipt)
    .postpone(CheckoutState.Paying, [CheckoutEvent.Add, CheckoutEvent.Add])
    .onAny(CheckoutEvent.Timeout, function abandon() {
      return CheckoutState.Cancelled;
    })
    .background(function heartbeat() {
      return Effect.void;
    })
    .final(CheckoutState.Receipt)
    .final(CheckoutState.Cancelled);

describe("Machine.definition", () => {
  test("lists every registration by state, in schema order", () => {
    const definition = Machine.definition(makeCheckout());

    expect(definition.events).toStrictEqual([
      "Add",
      "Pay",
      "Paid",
      "Declined",
      "Cancel",
      "Timeout",
    ]);
    expect(definition.states).toStrictEqual([
      {
        tag: "Browsing",
        transitions: [
          {
            method: "on",
            event: "Add",
            guarded: false,
            reenter: false,
            handlerName: "startCart",
            guardName: undefined,
          },
        ],
        immediate: [],
        effects: [],
        postponed: [],
        final: false,
      },
      {
        tag: "Cart",
        transitions: [
          {
            method: "reenter",
            event: "Add",
            guarded: false,
            reenter: true,
            handlerName: "addItem",
            guardName: undefined,
          },
          {
            method: "when",
            event: "Pay",
            guarded: true,
            reenter: false,
            handlerName: undefined,
            guardName: "hasItems",
          },
          {
            method: "on",
            event: "Cancel",
            guarded: false,
            reenter: false,
            handlerName: "cancel",
            guardName: undefined,
          },
        ],
        immediate: [
          {
            method: "immediateWhen",
            guarded: true,
            handlerName: undefined,
            guardName: "isEmpty",
          },
        ],
        effects: [],
        postponed: [],
        final: false,
      },
      {
        tag: "Paying",
        transitions: [
          {
            method: "on",
            event: "Cancel",
            guarded: false,
            reenter: false,
            handlerName: "cancel",
            guardName: undefined,
          },
          {
            method: "on",
            event: "Paid",
            guarded: false,
            reenter: false,
            handlerName: undefined,
            guardName: undefined,
          },
        ],
        immediate: [],
        effects: [
          { method: "task", name: "charge" },
          { method: "spawn", name: "watchTerminal" },
          { method: "timeout", name: "$timeout:Paying" },
        ],
        postponed: ["Add"],
        final: false,
      },
      { tag: "Receipt", transitions: [], immediate: [], effects: [], postponed: [], final: true },
      {
        tag: "Cancelled",
        transitions: [],
        immediate: [],
        effects: [],
        postponed: [],
        final: true,
      },
    ]);
    expect(definition.anyState).toStrictEqual([
      {
        method: "onAny",
        event: "Timeout",
        guarded: false,
        reenter: false,
        handlerName: "abandon",
        guardName: undefined,
      },
    ]);
    expect(definition.background).toStrictEqual([{ method: "background", name: "heartbeat" }]);
  });

  test("reports the spawn name option for handlers without a function name", () => {
    const machine = Machine.make({
      state: CheckoutState,
      event: CheckoutEvent,
      initial: CheckoutState.Browsing,
    })
      .spawn(
        CheckoutState.Paying,
        Effect.fn("Checkout.watchTerminal")(function* () {
          yield* Effect.void;
        }),
        { name: "watchTerminal" },
      )
      .spawn(
        CheckoutState.Paying,
        Effect.fn("Checkout.watchPrinter")(function* () {
          yield* Effect.void;
        }),
        { name: "watchPrinter" },
      )
      .spawn([CheckoutState.Cart, CheckoutState.Paying], () => Effect.void, { name: "heartbeat" })
      .spawn(CheckoutState.Cart, function watchCart() {
        return Effect.void;
      });

    const effectsOf = (tag: string) =>
      Machine.definition(machine).states.find((state) => state.tag === tag)?.effects;

    expect(effectsOf("Paying")).toStrictEqual([
      { method: "spawn", name: "watchTerminal" },
      { method: "spawn", name: "watchPrinter" },
      { method: "spawn", name: "heartbeat" },
    ]);
    expect(effectsOf("Cart")).toStrictEqual([
      { method: "spawn", name: "heartbeat" },
      { method: "spawn", name: "watchCart" },
    ]);
  });

  it.live("lists candidates in the order the runtime tries them", () =>
    Effect.gen(function* () {
      const machine = Machine.make({
        state: CheckoutState,
        event: CheckoutEvent,
        initial: CheckoutState.Browsing,
      })
        .when(
          CheckoutState.Cart,
          CheckoutEvent.Pay,
          function isOverLimit({ state }) {
            return state.items > 10;
          },
          function reject() {
            return CheckoutState.Cancelled;
          },
        )
        .when(CheckoutState.Cart, CheckoutEvent.Pay, hasItems, function pay({ state }) {
          return CheckoutState.Paying({ items: state.items });
        })
        .whenAny(
          CheckoutEvent.Pay,
          function always() {
            return true;
          },
          function payWithoutCart() {
            return CheckoutState.Receipt;
          },
        );
      const definition = Machine.definition(machine);
      const candidates = (tag: string) => [
        ...(definition.states.find((state) => state.tag === tag)?.transitions ?? []),
        ...definition.anyState,
      ];

      expect(candidates("Cart").map((entry) => entry.handlerName)).toStrictEqual([
        "reject",
        "pay",
        "payWithoutCart",
      ]);
      // Every guard passes, so the first candidate wins.
      const overLimit = yield* Machine.replay(machine, [CheckoutEvent.Pay], {
        from: CheckoutState.Cart({ items: 11 }),
      });
      expect(overLimit._tag).toBe("Cancelled");
      // The first guard fails, so the next candidate wins.
      const withinLimit = yield* Machine.replay(machine, [CheckoutEvent.Pay], {
        from: CheckoutState.Cart({ items: 2 }),
      });
      expect(withinLimit._tag).toBe("Paying");

      expect(candidates("Browsing").map((entry) => entry.method)).toStrictEqual(["whenAny"]);
      const fromBrowsing = yield* Machine.replay(machine, [CheckoutEvent.Pay]);
      expect(fromBrowsing._tag).toBe("Receipt");
    }),
  );

  test("accepts machines with different input types and explicit tag types", () => {
    const staticMachine = Machine.make({
      state: CheckoutState,
      event: CheckoutEvent,
      initial: CheckoutState.Browsing,
    });
    const inputMachine = Machine.make({
      state: CheckoutState,
      event: CheckoutEvent,
      initial: (input: { readonly items: number }) => CheckoutState.Cart({ items: input.items }),
    });

    const definitions = [staticMachine, inputMachine].map((machine) => Machine.definition(machine));
    const explicit = Machine.definition<typeof CheckoutState.Type, typeof CheckoutEvent.Type>(
      staticMachine,
    );

    const eventTags: ReadonlyArray<(typeof CheckoutEvent.Type)["_tag"]> = [
      "Add",
      "Pay",
      "Paid",
      "Declined",
      "Cancel",
      "Timeout",
    ];
    expect(definitions.map((definition) => definition.states.length)).toStrictEqual([5, 5]);
    expect(definitions.map((definition) => definition.events)).toStrictEqual([
      eventTags,
      eventTags,
    ]);
    expect(explicit.events).toStrictEqual(eventTags);

    // The union result keeps the schema's literal tag unions, not `string` or `any`.
    const stateTags: ReadonlyArray<"Browsing" | "Cart" | "Paying" | "Receipt" | "Cancelled"> =
      definitions.flatMap((definition) => definition.states.map((state) => state.tag));
    const firstEvent = definitions[0]?.events[0];
    // @ts-expect-error - "Shipped" is not an event tag of the checkout schema
    expect(firstEvent === "Shipped").toBe(false);
    expect(stateTags).toHaveLength(10);
  });

  test("returns a frozen snapshot and leaves the builder open", () => {
    const machine = Machine.make({
      state: CheckoutState,
      event: CheckoutEvent,
      initial: CheckoutState.Browsing,
    })
      .on(CheckoutState.Browsing, CheckoutEvent.Add, () => CheckoutState.Cart({ items: 1 }))
      .spawn(CheckoutState.Browsing, () => Effect.void)
      .postpone(CheckoutState.Browsing, CheckoutEvent.Pay);
    const before = Machine.definition(machine);
    const browsing = before.states[0];

    expect(Object.isFrozen(before)).toBe(true);
    expect(Object.isFrozen(before.states)).toBe(true);
    expect(Object.isFrozen(browsing)).toBe(true);
    expect(Object.isFrozen(browsing?.transitions)).toBe(true);
    expect(Object.isFrozen(browsing?.transitions[0])).toBe(true);

    // Same state and event: the builder pushes into the arrays the first call read.
    machine
      .on(CheckoutState.Browsing, CheckoutEvent.Add, () => CheckoutState.Cancelled)
      .spawn(CheckoutState.Browsing, () => Effect.void)
      .postpone(CheckoutState.Browsing, CheckoutEvent.Paid);
    const after = Machine.definition(machine);

    expect(browsing?.transitions).toHaveLength(1);
    expect(browsing?.effects).toHaveLength(1);
    expect(browsing?.postponed).toStrictEqual(["Pay"]);
    expect(after.states[0]?.transitions).toHaveLength(2);
    expect(after.states[0]?.effects).toHaveLength(2);
    expect(after.states[0]?.postponed).toStrictEqual(["Pay", "Paid"]);
    expect(after).not.toBe(before);
  });
});
