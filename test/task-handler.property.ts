/**
 * Generated type-level property for the `task` handler rule (issue #95); the rule and
 * the dimensions are in `test/task-handler/cells.ts`.
 *
 * This file is not a `*.test.ts` file, so `bun test` and the gate do not run it. Run it
 * with `bun run test:property` on any change to the `task` overloads or `TaskOptions`.
 * The default run checks the union of two full products and the fixed cases;
 * `TASK_PROPERTY_FULL=1` checks the one full product of all dimensions.
 */
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { type Cell, fixedCells, generatedCells } from "./task-handler/cells";
import { checkCells, timeoutMsFor } from "./task-handler/tsc";

const full = Bun.env["TASK_PROPERTY_FULL"] === "1";
/** Both counts leave out the cells whose code repeats. */
const expectedGeneratedCountByFull: Record<`${boolean}`, number> = {
  false: 164_454,
  true: 673_254,
};
const expectedGeneratedCount = expectedGeneratedCountByFull[`${full}`];
const generated = generatedCells(full);
const checkedCells: ReadonlyArray<Cell> = [...generated, ...fixedCells];

describe("task handler rule (#95), generated property", () => {
  it.scopedLive(
    "every generated cell and every fixed case gets the rule's verdict",
    () =>
      Effect.gen(function* () {
        expect(fixedCells.length).toBe(102);
        expect(generated.length).toBe(expectedGeneratedCount);
        const mismatches = yield* checkCells(checkedCells);
        // A short list keeps a red run readable; the count says how many there are.
        expect({ count: mismatches.length, first: mismatches.slice(0, 20) }).toEqual({
          count: 0,
          first: [],
        });
      }),
    timeoutMsFor(checkedCells.length),
  );
});
