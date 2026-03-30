import { Effect, Schema } from "effect";
import { describe, expect, test } from "bun:test";

import {
  assertNeverReaches,
  assertPath,
  Event,
  Machine,
  simulate,
  Slot,
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
      sectionIndex: Schema.Number,
      itemIndex: Schema.NullOr(Schema.Number),
    },
    ItemSelected: { pageId: Schema.String, sectionIndex: Schema.Number, itemId: Schema.String },
    Checkout: { items: Schema.Array(Schema.String) },
    Closed: {},
  });
  type MenuState = typeof MenuState.Type;

  const MenuEvent = Event({
    NavigateToPage: { pageId: Schema.String },
    ScrollToSection: { sectionIndex: Schema.Number },
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

  const MenuSlots = Slot.define({
    canNavigateToPage: Slot.fn({}, Schema.Boolean),
    canScrollToSection: Slot.fn({}, Schema.Boolean),
  });

  const menuMachine = Machine.make({
    state: MenuState,
    event: MenuEvent,
    slots: MenuSlots,
    initial: MenuState.Browsing({ pageId: "food", sectionIndex: 0, itemIndex: null }),
  })
    // Browsing handlers
    // Navigate to different page (reset section)
    .on(MenuState.Browsing, MenuEvent.NavigateToPage, ({ state, event, slots }) =>
      Effect.gen(function* () {
        if (yield* slots.canNavigateToPage()) {
          return MenuState.Browsing({ pageId: event.pageId, sectionIndex: 0, itemIndex: null });
        }
        return state;
      }),
    )
    // Scroll to section
    .on(MenuState.Browsing, MenuEvent.ScrollToSection, ({ state, event, slots }) =>
      Effect.gen(function* () {
        if (yield* slots.canScrollToSection()) {
          return MenuState.Browsing({
            ...state,
            sectionIndex: event.sectionIndex,
            itemIndex: null,
          });
        }
        return state;
      }),
    )
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

  const menuSlots = {
    canNavigateToPage: () =>
      Effect.gen(function* () {
        const ctx = yield* menuMachine.Context;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = ctx.state as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ctx.event as any;
        return s.pageId !== e.pageId && pages.some((p: Page) => p.id === e.pageId);
      }),
    canScrollToSection: () =>
      Effect.gen(function* () {
        const ctx = yield* menuMachine.Context;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const s = ctx.state as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const e = ctx.event as any;
        const page = pages.find((p: Page) => p.id === s.pageId);
        return page !== undefined && e.sectionIndex >= 0 && e.sectionIndex < page.sections.length;
      }),
  };

  test("page navigation with valid page", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [MenuEvent.NavigateToPage({ pageId: "drinks" })],
          { slots: menuSlots },
        );

        expect(result.finalState._tag).toBe("Browsing");
        expect((result.finalState as BrowsingState).pageId).toBe("drinks");
        expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
      }),
    );
  });

  test("page navigation to same page is no-op", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [
            MenuEvent.ScrollToSection({ sectionIndex: 1 }),
            MenuEvent.NavigateToPage({ pageId: "food" }), // Same page
          ],
          { slots: menuSlots },
        );

        // Section should still be 1 (internal transition preserved state)
        expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
      }),
    );
  });

  test("page navigation to invalid page blocked", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [MenuEvent.NavigateToPage({ pageId: "nonexistent" })],
          { slots: menuSlots },
        );

        // Should stay on food (initial page)
        expect((result.finalState as BrowsingState).pageId).toBe("food");
      }),
    );
  });

  test("section scrolling with valid index", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [MenuEvent.ScrollToSection({ sectionIndex: 1 })],
          { slots: menuSlots },
        );

        expect((result.finalState as BrowsingState).sectionIndex).toBe(1);
      }),
    );
  });

  test("section scrolling with invalid index blocked", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [
            MenuEvent.ScrollToSection({ sectionIndex: 99 }), // Invalid
          ],
          { slots: menuSlots },
        );

        expect((result.finalState as BrowsingState).sectionIndex).toBe(0);
      }),
    );
  });

  test("item selection flow", async () => {
    await Effect.runPromise(
      assertPath(
        menuMachine,
        [MenuEvent.SelectItem({ itemId: "burger" }), MenuEvent.AddToCart],
        ["Browsing", "ItemSelected", "Browsing"],
        { slots: menuSlots },
      ),
    );
  });

  test("cancel selection returns to browsing", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [
            MenuEvent.ScrollToSection({ sectionIndex: 1 }),
            MenuEvent.SelectItem({ itemId: "burger" }),
            MenuEvent.Close,
          ],
          { slots: menuSlots },
        );

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
        [MenuEvent.SelectItem({ itemId: "fries" }), MenuEvent.AddToCart, MenuEvent.GoToCheckout],
        ["Browsing", "ItemSelected", "Browsing", "Checkout"],
        { slots: menuSlots },
      ),
    );
  });

  test("close menu from browsing", async () => {
    await Effect.runPromise(
      assertPath(menuMachine, [MenuEvent.Close], ["Browsing", "Closed"], { slots: menuSlots }),
    );
  });

  test("navigation never reaches checkout without explicit action", async () => {
    await Effect.runPromise(
      assertNeverReaches(
        menuMachine,
        [
          MenuEvent.NavigateToPage({ pageId: "drinks" }),
          MenuEvent.ScrollToSection({ sectionIndex: 1 }),
          MenuEvent.NavigateToPage({ pageId: "food" }),
        ],
        "Checkout",
        { slots: menuSlots },
      ),
    );
  });

  test("complex navigation flow", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const result = yield* simulate(
          menuMachine,
          [
            MenuEvent.NavigateToPage({ pageId: "drinks" }),
            MenuEvent.ScrollToSection({ sectionIndex: 1 }),
            MenuEvent.SelectItem({ itemId: "beer" }),
            MenuEvent.Close, // Cancel, back to browsing
            MenuEvent.NavigateToPage({ pageId: "food" }),
            MenuEvent.SelectItem({ itemId: "burger" }),
            MenuEvent.AddToCart,
            MenuEvent.GoToCheckout,
          ],
          { slots: menuSlots },
        );

        expect(result.finalState._tag).toBe("Checkout");
      }),
    );
  });
});
