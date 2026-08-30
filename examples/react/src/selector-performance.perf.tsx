import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { makeCounterActorAtom } from "../../counter.js";
import { App } from "./app.js";

describe("React selector performance", () => {
  it("isolates selector renders and keeps exit data in the terminal state", () => {
    let countRenders = 0;
    let labelRenders = 0;
    let statusRenders = 0;
    const view = render(
      <App
        actorAtom={makeCounterActorAtom()}
        renders={{
          count: () => countRenders++,
          label: () => labelRenders++,
          status: () => statusRenders++,
        }}
      />,
    );

    return waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Counter"))
      .then(() => {
        expect(countRenders).toBe(1);
        expect(labelRenders).toBe(1);
        expect(statusRenders).toBe(1);
        fireEvent.click(screen.getByRole("button", { name: "Rename" }));
        return waitFor(() => expect(screen.getByRole("heading").textContent).toBe("Renamed"));
      })
      .then(() => {
        expect(countRenders).toBe(1);
        expect(labelRenders).toBe(2);
        expect(statusRenders).toBe(1);
        fireEvent.click(screen.getByRole("button", { name: "Increment" }));
        return waitFor(() => expect(screen.getByLabelText("Count").textContent).toBe("1"));
      })
      .then(() => {
        expect(countRenders).toBe(2);
        expect(labelRenders).toBe(2);
        expect(statusRenders).toBe(1);
        fireEvent.click(screen.getByRole("button", { name: "Finish" }));
        return waitFor(() => expect(screen.getByLabelText("Status").textContent).toBe("Done"));
      })
      .then(() => {
        expect(screen.getByRole("heading").textContent).toBe("Renamed");
        expect(screen.getByLabelText("Count").textContent).toBe("1");
        expect(screen.getByTestId("counter-screen")).toBeDefined();
        expect(countRenders).toBe(2);
        expect(labelRenders).toBe(2);
        expect(statusRenders).toBe(2);
        return waitFor(() => expect(screen.queryByTestId("counter-screen")).toBeNull());
      })
      .then(() => {
        view.unmount();
      });
  });
});
