/**
 * The fixed `task` cases of issue #95: every earlier counterexample and review probe,
 * checked with tsc against the handler rule (see `test/task-handler/cells.ts`).
 * The generated property runs with `bun run test:property`.
 */
import { Effect } from "effect";
import { describe, expect, it } from "effect-bun-test";

import { fixedCells } from "./task-handler/cells";
import { checkCells, timeoutMsFor } from "./task-handler/tsc";

describe("task handler rule (#95)", () => {
  it.scopedLive(
    "every fixed case gets the rule's verdict",
    () =>
      Effect.gen(function* () {
        expect(fixedCells.length).toBe(102);
        const mismatches = yield* checkCells(fixedCells);
        expect(mismatches).toEqual([]);
      }),
    timeoutMsFor(fixedCells.length),
  );
});
