import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { actorSystemProgram } from "../src/actor-system.js";
import { atomProgram } from "../src/atom.js";
import { basicProgram } from "../src/basic.js";
import { compositionProgram } from "../src/composition.js";
import { runEffectGuard } from "../src/effect-guard.js";
import { hardwareNavigationProgram } from "../src/hardware-navigation.js";
import { inspectionProgram } from "../src/inspection.js";
import { persistenceProgram } from "../src/persistence.js";
import { servicesAndTasksProgram } from "../src/services-and-tasks.js";
import { supervisionProgram } from "../src/supervision.js";

describe("core examples", () => {
  it.scopedLive("runs a guarded machine", () =>
    Effect.map(basicProgram, (output) => expect(output).toBe(2)),
  );

  it.scopedLive("uses an Effect service in a transition predicate", () =>
    Effect.gen(function* () {
      const result = yield* runEffectGuard;
      expect(result.canCheckout).toBe(true);
      expect(result.state._tag).toBe("Checkout");
    }),
  );

  it.scopedLive("runs a task with an Effect service", () =>
    Effect.map(servicesAndTasksProgram, (output) =>
      expect(output).toEqual(["coffee beans", "coffee grinder"]),
    ),
  );

  it.scopedLive("composes machine output with Effect", () =>
    Effect.map(compositionProgram, (output) => expect(output).toBe("cart-123-4200")),
  );

  it.scopedLive("runs a named parent and child actor", () =>
    Effect.map(actorSystemProgram, (output) => expect(output).toBe(true)),
  );

  it.scopedLive("maps a device stream to machine events", () =>
    Effect.map(hardwareNavigationProgram, (output) => expect(output).toBe(2)),
  );

  it.scopedLive("recovers the last durable state", () =>
    Effect.map(persistenceProgram, (output) => expect(output.text).toBe("Retained draft")),
  );

  it.scopedLive("restarts after a supervised defect", () =>
    Effect.map(supervisionProgram, (output) => expect(output).toBe("recovered")),
  );

  it.scopedLive("inspects named guards and transition operations", () =>
    Effect.map(inspectionProgram, (events) => {
      const guards = events.filter((event) => event.type === "@machine.guard");
      const operations = events.filter((event) => event.type === "@machine.operation");
      expect(guards.map((event) => event.result)).toEqual([false, true]);
      expect(operations.map((event) => event.operation)).toEqual(["recordFailedAttempt", "unlock"]);
      expect(events.every((event) => event.generation === 0)).toBe(true);
    }),
  );

  it.scopedLive("updates only the selected Atom value", () =>
    Effect.map(atomProgram, (output) => expect(output).toEqual([0, 1])),
  );
});
