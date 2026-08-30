import { Effect, Schema } from "effect";
import { describe, expect, it } from "effect-bun-test";

import {
  assertNeverReaches,
  assertPath,
  Event,
  Machine,
  simulate,
  State,
} from "../../src/index.js";

/**
 * Menu navigation pattern tests based on bite menu.machine.ts
 * Tests: page navigation with guards, section scrolling, item selection
 */
describe("Menu Navigation Pattern", () => {
  type Page = { id: string; sections: Section[] };
  type Section = { id: string; items: Item[] };
  type Item = { id: string; name: string; available: boolean };

  const MenuState = State({
    Browsing: {
      pageId: Schema.String,
      sectionIndex: Schema.Finite,
      itemIndex: Schema.NullOr(Schema.Finite),
    },
    ItemSelected: { pageId: Schema.String, sectionIndex: Schema.Finite, itemId: Schema.String },
    Checkout: { items: Schema.Array(Schema.String) },
    Closed: {},
  });
  type MenuState = typeof MenuState.Type;

  const MenuEvent = Event({
    NavigateToPage: { pageId: Schema.String },
    ScrollToSection: { sectionIndex: Schema.Finite },
    SelectItem: { itemId: Schema.String },
    AddToCart: {},
    GoToCheckout: {},
    Close: {},
  });
  type MenuEvent = typeof MenuEvent.Type;

  // State/Event type aliases for guards
  type BrowsingState = MenuState & { _tag: "Browsing" };

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

  const menuMachine = Machine.make({
    state: MenuState,
    event: MenuEvent,
    initial: MenuState.Browsing({ pageId: "food", sectionIndex: 0, itemIndex: null }),
  })
    // Browsing handlers
    // Navigate to different page (reset section)
    .on(MenuState.Browsing, MenuEvent.NavigateToPage, ({ state, event }) => {
      if (state.pageId !== event.pageId && pages.some((page) => page.id === event.pageId)) {
        return MenuState.Browsing({ pageId: event.pageId, sectionIndex: 0, itemIndex: null });
      }
      return state;
    })
    // Scroll to section
    .on(MenuState.Browsing, MenuEvent.ScrollToSection, ({ state, event }) => {
      const page = pages.find((candidate) => candidate.id === state.pageId);
      if (
        page !== undefined &&
        event.sectionIndex >= 0 &&
        event.sectionIndex < page.sections.length
      ) {
        return MenuState.Browsing({
          ...state,
          sectionIndex: event.sectionIndex,
          itemIndex: null,
        });
      }
      return state;
    })
    // Select item
    .on(MenuState.Browsing, MenuEvent.SelectItem, ({ state, event }) =>
      MenuState.ItemSelected({
        pageId: state.pageId,
        sectionIndex: state.sectionIndex,
        itemId: event.itemId,
      }),
    )
    // Go to checkout
    .on(MenuState.Browsing, MenuEvent.GoToCheckout, () => MenuState.Checkout({ items: [...cart] }))
    // Close menu
    .on(MenuState.Browsing, MenuEvent.Close, () => MenuState.Closed)
    // ItemSelected handlers
    // Add to cart and return to browsing
    .on(MenuState.ItemSelected, MenuEvent.AddToCart, ({ state }) => {
      cart.push(state.itemId);
      return MenuState.Browsing({
        pageId: state.pageId,
        sectionIndex: state.sectionIndex,
        itemIndex: null,
      });
    })
    // Cancel selection - return to browsing
    .on(MenuState.ItemSelected, MenuEvent.Close, ({ state }) =>
      MenuState.Browsing({
        pageId: state.pageId,
        sectionIndex: state.sectionIndex,
        itemIndex: null,
      }),
    )
    // Checkout handlers
    .on(MenuState.Checkout, MenuEvent.Close, () => MenuState.Closed)
    .final(MenuState.Closed);

  it.scopedLive("page navigation with valid page", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [MenuEvent.NavigateToPage({ pageId: "drinks" })]);

      expect(result.finalState._tag).toBe("Browsing");
      expect((result.finalState as BrowsingState).pageId).toBe("drinks");
      expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
    }),
  );

  it.scopedLive("page navigation to same page is no-op", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [
        MenuEvent.ScrollToSection({ sectionIndex: 1 }),
        MenuEvent.NavigateToPage({ pageId: "food" }), // Same page
      ]);

      // Section should still be 1 (internal transition preserved state)
      expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
    }),
  );

  it.scopedLive("page navigation to invalid page blocked", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [
        MenuEvent.NavigateToPage({ pageId: "nonexistent" }),
      ]);

      // Should stay on food (initial page)
      expect((result.finalState as BrowsingState).pageId).toBe("food");
    }),
  );

  it.scopedLive("section scrolling with valid index", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [MenuEvent.ScrollToSection({ sectionIndex: 1 })]);

      expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
    }),
  );

  it.scopedLive("section scrolling with invalid index blocked", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [
        MenuEvent.ScrollToSection({ sectionIndex: 99 }), // Invalid
      ]);

      expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
    }),
  );

  it.scopedLive("item selection flow", () =>
    assertPath(
      menuMachine,
      [MenuEvent.SelectItem({ itemId: "burger" }), MenuEvent.AddToCart],
      ["Browsing", "ItemSelected", "Browsing"],
    ),
  );

  it.scopedLive("cancel selection returns to browsing", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [
        MenuEvent.ScrollToSection({ sectionIndex: 1 }),
        MenuEvent.SelectItem({ itemId: "burger" }),
        MenuEvent.Close,
      ]);

      expect(result.finalState._tag).toBe("Browsing");
      // Preserves section from before selection
      expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
    }),
  );

  it.scopedLive("checkout flow", () =>
    assertPath(
      menuMachine,
      [MenuEvent.SelectItem({ itemId: "fries" }), MenuEvent.AddToCart, MenuEvent.GoToCheckout],
      ["Browsing", "ItemSelected", "Browsing", "Checkout"],
    ),
  );

  it.scopedLive("close menu from browsing", () =>
    assertPath(menuMachine, [MenuEvent.Close], ["Browsing", "Closed"]),
  );

  it.scopedLive("navigation never reaches checkout without explicit action", () =>
    assertNeverReaches(
      menuMachine,
      [
        MenuEvent.NavigateToPage({ pageId: "drinks" }),
        MenuEvent.ScrollToSection({ sectionIndex: 1 }),
        MenuEvent.NavigateToPage({ pageId: "food" }),
      ],
      "Checkout",
    ),
  );

  it.scopedLive("complex navigation flow", () =>
    Effect.gen(function* () {
      const result = yield* simulate(menuMachine, [
        MenuEvent.NavigateToPage({ pageId: "drinks" }),
        MenuEvent.ScrollToSection({ sectionIndex: 1 }),
        MenuEvent.SelectItem({ itemId: "beer" }),
        MenuEvent.Close, // Cancel, back to browsing
        MenuEvent.NavigateToPage({ pageId: "food" }),
        MenuEvent.SelectItem({ itemId: "burger" }),
        MenuEvent.AddToCart,
        MenuEvent.GoToCheckout,
      ]);

      expect(result.finalState._tag).toBe("Checkout");
    }),
  );
});
