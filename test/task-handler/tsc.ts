/**
 * Checks `task` cells with the project's tsc and compares each verdict with the rule.
 *
 * The cells go into shards under `node_modules/.cache` (so that `effect` resolves).
 * Separate tsc processes check the shards in parallel with the Effect language-service
 * diagnostics off, so the verdict is TypeScript's.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

import { Effect, type Scope } from "effect";

import { type Cell, preamble } from "./cells";

const repositoryRoot = join(import.meta.dir, "..", "..");

// One file of many thousand cells makes tsc slow down more than linearly, so the cells
// go into shards that separate tsc processes check in parallel.
const shardSize = 1200;
const concurrency = Math.min(16, availableParallelism());

/**
 * The time budget follows the work: the shards run in waves of `concurrency` tsc
 * processes. Measured on 4 pinned cores of an AMD EPYC 9554P: 7.1 to 7.5 s per wave of
 * 1200-cell shards. The budget gives each wave 30 s (4 times), plus 60 s to generate
 * and write the cells, so it also covers the full product on a slower machine.
 */
export const timeoutMsFor = (cellCount: number): number =>
  60_000 + Math.ceil(Math.ceil(cellCount / shardSize) / concurrency) * 30_000;

interface Located extends Cell {
  readonly shard: number;
  readonly first: number;
  readonly last: number;
}

export interface Mismatch {
  readonly id: string;
  readonly expectedToCompile: boolean;
  readonly diagnostics: ReadonlyArray<string>;
}

interface TscRun {
  readonly output: string;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

/** Writes the cell shards and one tsconfig per shard into `root`; returns each cell with its lines. */
const writeShards = (
  root: string,
  cells: ReadonlyArray<Cell>,
): {
  readonly located: ReadonlyArray<Located>;
  readonly shardDirectories: ReadonlyArray<string>;
} => {
  const located: Array<Located> = [];
  const shardDirectories: Array<string> = [];
  for (let start = 0, shard = 0; start < cells.length; start += shardSize, shard += 1) {
    const lines = preamble.split("\n");
    for (const cell of cells.slice(start, start + shardSize)) {
      lines.push(`// CELL ${cell.id}`);
      const first = lines.length + 1;
      lines.push(...cell.code.split("\n"));
      located.push({ ...cell, shard, first, last: lines.length });
    }
    const directory = join(root, `shard-${shard}`);
    mkdirSync(directory);
    writeFileSync(join(directory, "cases.ts"), lines.join("\n") + "\n");
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        extends: join(repositoryRoot, "tsconfig.json"),
        // The verdict is TypeScript's: the Effect language-service checks stay off, so its
        // lint rules neither add rejects in cells nor report the library files.
        compilerOptions: {
          noEmit: true,
          plugins: [{ name: "@effect/language-service", diagnostics: false }],
          paths: { LIB: [join(repositoryRoot, "src", "index.ts")] },
        },
        files: ["cases.ts"],
        include: [],
      }),
    );
    shardDirectories.push(directory);
  }
  return { located, shardDirectories };
};

/**
 * Runs the project's tsc on one shard and returns its output and how it ended. An
 * interruption (a test timeout, a failed sibling) kills and reaps the child.
 */
const runTsc = (directory: string): Effect.Effect<TscRun> =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      Bun.spawn(
        [join(repositoryRoot, "node_modules", ".bin", "tsc"), "-p", directory, "--pretty", "false"],
        { cwd: directory, stdout: "pipe", stderr: "pipe" },
      ),
    ),
    (child) =>
      Effect.gen(function* () {
        const [stdout, stderr] = yield* Effect.all(
          [
            Effect.promise(() => new Response(child.stdout).text()),
            Effect.promise(() => new Response(child.stderr).text()),
          ],
          { concurrency: "unbounded" },
        );
        yield* Effect.promise(() => child.exited);
        return { output: stdout + stderr, exitCode: child.exitCode, signalCode: child.signalCode };
      }),
    (child) =>
      Effect.promise(() => {
        child.kill("SIGKILL");
        return child.exited;
      }),
  );

/** tsc exits 0 without diagnostics and 1 or 2 with them; anything else is a crash. */
const tscExitCodeSet: ReadonlySet<number | null> = new Set([0, 1, 2]);

/**
 * Maps each tsc diagnostic to its cell and returns every verdict that breaks the rule,
 * plus every diagnostic outside a cell or outside `cases.ts`, every diagnostic
 * without a file position, and every tsc run that crashed.
 */
const findMismatches = (
  located: ReadonlyArray<Located>,
  runs: ReadonlyArray<TscRun>,
): ReadonlyArray<Mismatch> => {
  const outside: Array<Mismatch> = [];
  const diagnosticsByLineByShard = runs.map((run, shard) => {
    if (run.signalCode !== null || !tscExitCodeSet.has(run.exitCode)) {
      outside.push({
        id: `<shard ${shard}: tsc ended with exit code ${run.exitCode} and signal ${run.signalCode}>`,
        expectedToCompile: true,
        diagnostics: [run.output.slice(-2000)],
      });
    }
    for (const match of run.output.matchAll(/^error TS\d+: .*(?:\n[ \t]+.*)*/gm)) {
      outside.push({
        id: `<shard ${shard}: diagnostic without a file position>`,
        expectedToCompile: true,
        diagnostics: [match[0]],
      });
    }
    const diagnosticsByLine = new Map<number, Array<string>>();
    // A diagnostic is its first line plus the indented detail lines below it.
    for (const match of run.output.matchAll(
      /^(.*?)\((\d+),\d+\): (error TS\d+: .*(?:\n[ \t]+.*)*)/gm,
    )) {
      const file = match[1] ?? "";
      const message = match[3] ?? "";
      if (!file.endsWith("cases.ts")) {
        outside.push({
          id: `<outside cases.ts: ${file}>`,
          expectedToCompile: true,
          diagnostics: [message],
        });
        continue;
      }
      const line = Number(match[2]);
      diagnosticsByLine.set(line, [...(diagnosticsByLine.get(line) ?? []), message]);
    }
    const cellLineSet = new Set<number>();
    for (const cell of located) {
      if (cell.shard !== shard) continue;
      for (let line = cell.first; line <= cell.last; line += 1) cellLineSet.add(line);
    }
    for (const [line, diagnostics] of diagnosticsByLine) {
      if (!cellLineSet.has(line)) {
        outside.push({
          id: `<shard ${shard} line ${line}, outside any cell>`,
          expectedToCompile: true,
          diagnostics,
        });
      }
    }
    return diagnosticsByLine;
  });

  const broken = located.flatMap((cell): ReadonlyArray<Mismatch> => {
    const own: Array<string> = [];
    for (let line = cell.first; line <= cell.last; line += 1) {
      own.push(...(diagnosticsByLineByShard[cell.shard]?.get(line) ?? []));
    }
    if (cell.compiles === (own.length === 0)) return [];
    return [{ id: cell.id, expectedToCompile: cell.compiles, diagnostics: own }];
  });
  return [...outside, ...broken];
};

/**
 * Checks every cell with tsc and returns the mismatches. `TASK_PROPERTY_REPORT=<path>`
 * also writes every mismatch to that file, one JSON line each.
 */
export const checkCells = (
  cells: ReadonlyArray<Cell>,
): Effect.Effect<ReadonlyArray<Mismatch>, never, Scope.Scope> =>
  Effect.gen(function* () {
    // The cases live next to `node_modules/effect` so that it resolves; the scope deletes them.
    const root = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const cacheRoot = join(repositoryRoot, "node_modules", ".cache");
        mkdirSync(cacheRoot, { recursive: true });
        return mkdtempSync(join(cacheRoot, "task-handler-"));
      }),
      (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
    );
    const { located, shardDirectories } = writeShards(root, cells);
    const runs = yield* Effect.forEach(shardDirectories, runTsc, { concurrency });
    const mismatches = findMismatches(located, runs);
    const reportPath = Bun.env["TASK_PROPERTY_REPORT"];
    if (reportPath !== undefined) {
      writeFileSync(reportPath, mismatches.map((mismatch) => JSON.stringify(mismatch)).join("\n"));
    }
    return mismatches;
  });
