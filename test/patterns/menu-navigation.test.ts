import { Data, Effect, pipe } from "effect";
import { describe, expect, test } from "bun:test";

import {
  assertNeverReaches,
  assertPath,
  build,
  final,
  Guard,
  make,
  on,
  simulate,
} from "../../src/index.js";

/**
 * Menu navigation pattern tests based on bite menu.machine.ts
 * Tests: page navigation with guards, section scrolling, item selection
 */
describe("Menu Navigation Pattern", () => {
  type Page = { id: string; sections: Section[] };
  type Section = { id: string; items: Item[] };
  type Item = { id: string; name: string; available: boolean };

  type MenuState = Data.TaggedEnum<{
    Browsing: { pageId: string; sectionIndex: number; itemIndex: number | null };
    ItemSelected: { pageId: string; sectionIndex: number; itemId: string };
    Checkout: { items: string[] };
    Closed: {};
  }>;
  const State = Data.taggedEnum<MenuState>();

  type MenuEvent = Data.TaggedEnum<{
    NavigateToPage: { pageId: string };
    ScrollToSection: { sectionIndex: number };
    SelectItem: { itemId: string };
    AddToCart: {};
    GoToCheckout: {};
    Close: {};
  }>;
  const Event = Data.taggedEnum<MenuEvent>();

  // State/Event type aliases for guards
  type BrowsingState = MenuState & { _tag: "Browsing" };
  type NavigateEvent = MenuEvent & { _tag: "NavigateToPage" };
  type ScrollEvent = MenuEvent & { _tag: "ScrollToSection" };

  // Mock data
  const pages: Page[] = [
    {
      id: "food",
      sections: [
        { id: "appetizers", items: [{ id: "fries", name: "Fries", available: true }] },
        { id: "mains", items: [{ id: "burger", name: "Burger", available: true }] },
      ],
    },
    {
      id: "drinks",
      sections: [
        { id: "soft", items: [{ id: "cola", name: "Cola", available: true }] },
        { id: "alcohol", items: [{ id: "beer", name: "Beer", available: false }] },
      ],
    },
  ];

  const cart: string[] = [];

  // Guards
  const isValidPage = Guard.make<BrowsingState, NavigateEvent>(({ event }) =>
    pages.some((p) => p.id === event.pageId),
  );

  const isValidSection = Guard.make<BrowsingState, ScrollEvent>(({ state, event }) => {
    const page = pages.find((p) => p.id === state.pageId);
    return page !== undefined
      ? event.sectionIndex >= 0 && event.sectionIndex < page.sections.length
      : false;
  });

  const isDifferentPage = Guard.make<BrowsingState, NavigateEvent>(
    ({ state, event }) => state.pageId !== event.pageId,
  );

  const menuMachine = build(
    pipe(
      make<MenuState, MenuEvent>(
        State.Browsing({ pageId: "food", sectionIndex: 0, itemIndex: null }),
      ),

      // Page navigation with guard cascade
      // First: check if different page AND valid
      on(
        State.Browsing,
        Event.NavigateToPage,
        ({ event }) => State.Browsing({ pageId: event.pageId, sectionIndex: 0, itemIndex: null }),
        { guard: Guard.and(isDifferentPage, isValidPage) },
      ),
      // Second: same page - no-op (same state, no lifecycle by default)
      on(State.Browsing, Event.NavigateToPage, ({ state }) => state, {
        guard: Guard.not(isDifferentPage),
      }),

      // Section scrolling (same state, no lifecycle by default)
      on(
        State.Browsing,
        Event.ScrollToSection,
        ({ state, event }) =>
          State.Browsing({ ...state, sectionIndex: event.sectionIndex, itemIndex: null }),
        { guard: isValidSection },
      ),

      // Item selection
      on(State.Browsing, Event.SelectItem, ({ state, event }) =>
        State.ItemSelected({
          pageId: state.pageId,
          sectionIndex: state.sectionIndex,
          itemId: event.itemId,
        }),
      ),

      // Add to cart and return to browsing
      on(State.ItemSelected, Event.AddToCart, ({ state }) => {
        cart.push(state.itemId);
        return State.Browsing({
          pageId: state.pageId,
          sectionIndex: state.sectionIndex,
          itemIndex: null,
        });
      }),

      // Cancel selection
      on(State.ItemSelected, Event.Close, ({ state }) =>
        State.Browsing({ pageId: state.pageId, sectionIndex: state.sectionIndex, itemIndex: null }),
      ),

      // Go to checkout
      on(State.Browsing, Event.GoToCheckout, () => State.Checkout({ items: [...cart] })),

      // Close menu
      on(State.Browsing, Event.Close, () => State.Closed()),
      on(State.Checkout, Event.Close, () => State.Closed()),

      final(State.Closed),
    ),
  );

  test("page navigation with valid page", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [Event.NavigateToPage({ pageId: "drinks" })]);

        expect(result.finalState._tag).toBe("Browsing");
        expect((result.finalState as BrowsingState).pageId).toBe("drinks");
        expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
      }),
    );
  });

  test("page navigation to same page is no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [
          Event.ScrollToSection({ sectionIndex: 1 }),
          Event.NavigateToPage({ pageId: "food" }), // Same page
        ]);

        // Section should still be 1 (internal transition preserved state)
        expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
      }),
    );
  });

  test("page navigation to invalid page blocked", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [
          Event.NavigateToPage({ pageId: "nonexistent" }),
        ]);

        // Should stay on food (initial page)
        expect((result.finalState as BrowsingState).pageId).toBe("food");
      }),
    );
  });

  test("section scrolling with valid index", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [Event.ScrollToSection({ sectionIndex: 1 })]);

        expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
      }),
    );
  });

  test("section scrolling with invalid index blocked", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [
          Event.ScrollToSection({ sectionIndex: 99 }), // Invalid
        ]);

        expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
      }),
    );
  });

  test("item selection flow", async () => {
    await Effect.runPromise(
      assertPath(
        menuMachine,
        [Event.SelectItem({ itemId: "burger" }), Event.AddToCart()],
        ["Browsing", "ItemSelected", "Browsing"],
      ),
    );
  });

  test("cancel selection returns to browsing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [
          Event.ScrollToSection({ sectionIndex: 1 }),
          Event.SelectItem({ itemId: "burger" }),
          Event.Close(),
        ]);

        expect(result.finalState._tag).toBe("Browsing");
        // Preserves section from before selection
        expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
      }),
    );
  });

  test("checkout flow", async () => {
    await Effect.runPromise(
      assertPath(
        menuMachine,
        [Event.SelectItem({ itemId: "fries" }), Event.AddToCart(), Event.GoToCheckout()],
        ["Browsing", "ItemSelected", "Browsing", "Checkout"],
      ),
    );
  });

  test("close menu from browsing", async () => {
    await Effect.runPromise(assertPath(menuMachine, [Event.Close()], ["Browsing", "Closed"]));
  });

  test("navigation never reaches checkout without explicit action", async () => {
    await Effect.runPromise(
      assertNeverReaches(
        menuMachine,
        [
          Event.NavigateToPage({ pageId: "drinks" }),
          Event.ScrollToSection({ sectionIndex: 1 }),
          Event.NavigateToPage({ pageId: "food" }),
        ],
        "Checkout",
      ),
    );
  });

  test("complex navigation flow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(menuMachine, [
          Event.NavigateToPage({ pageId: "drinks" }),
          Event.ScrollToSection({ sectionIndex: 1 }),
          Event.SelectItem({ itemId: "beer" }),
          Event.Close(), // Cancel, back to browsing
          Event.NavigateToPage({ pageId: "food" }),
          Event.SelectItem({ itemId: "burger" }),
          Event.AddToCart(),
          Event.GoToCheckout(),
        ]);

        expect(result.finalState._tag).toBe("Checkout");
      }),
    );
  });
});
