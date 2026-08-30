import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import { makeCounterActorAtom } from "@effect-machine/examples-shared/counter";
import { App } from "./app.js";

describe("Solid selector performance", () => {
  it("isolates selector computations and keeps exit data in the terminal state", () => {
    let countComputations = 0;
    let labelComputations = 0;
    let statusComputations = 0;
    let canIncrementComputations = 0;
    let initialCanIncrementComputations = 0;
    const view = render(() => (
      <App
        actorAtom={makeCounterActorAtom()}
        computations={{
          count: () => countComputations++,
          label: () => labelComputations++,
          status: () => statusComputations++,
          canIncrement: () => canIncrementComputations++,
        }}
      />
    ));

    return waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Counter"))
      .then(() => {
        expect(countComputations).toBe(1);
        expect(labelComputations).toBe(1);
        expect(statusComputations).toBe(1);
        initialCanIncrementComputations = canIncrementComputations;
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));
        return waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Renamed"));
      })
      .then(() => {
        expect(countComputations).toBe(1);
        expect(labelComputations).toBe(2);
        expect(statusComputations).toBe(1);
        expect(canIncrementComputations).toBe(initialCanIncrementComputations);
        fireEvent.click(screen.getByRole("button", { name: "Increment" }));
        return waitFor(() => expect(screen.getByLabelText("Count").textContent).toBe("1"));
      })
      .then(() => {
        expect(countComputations).toBe(2);
        expect(labelComputations).toBe(2);
        expect(statusComputations).toBe(1);
        expect(canIncrementComputations).toBe(initialCanIncrementComputations);
        fireEvent.click(screen.getByRole("button", { name: "Increment" }));
        return waitFor(() => expect(screen.getByLabelText("Count").textContent).toBe("2"));
      })
      .then(() => {
        expect(countComputations).toBe(3);
        expect(labelComputations).toBe(2);
        expect(statusComputations).toBe(1);
        expect(canIncrementComputations).toBe(initialCanIncrementComputations + 1);
        expect(screen.getByRole("button", { name: "Increment" }).hasAttribute("disabled")).toBe(
          true,
        );
        fireEvent.click(screen.getByRole("button", { name: "Finish" }));
        return waitFor(() => expect(screen.getByLabelText("Status").textContent).toBe("Done"));
      })
      .then(() => {
        expect(screen.getByRole("heading").textContent).toBe("Renamed");
        expect(screen.getByLabelText("Count").textContent).toBe("2");
        expect(screen.getByTestId("counter-screen")).toBeDefined();
        expect(countComputations).toBe(3);
        expect(labelComputations).toBe(2);
        expect(statusComputations).toBe(2);
        expect(canIncrementComputations).toBe(initialCanIncrementComputations + 1);
        return waitFor(() => expect(screen.queryByTestId("counter-screen")).toBeNull());
      })
      .then(() => {
        view.unmount();
      });
  });
});
