// @effect-diagnostics strictEffectProvide:off anyUnknownInErrorContext:off missingEffectContext:off
import type { Scope, TestServices } from "effect";
import { Effect, TestContext } from "effect";
import { describe as bunDescribe, expect, test as bunTest } from "bun:test";

type TestEnv = TestServices.TestServices;

/**
 * Yield to allow forked fibers to process.
 * Multiple yields are needed when delay timers are registered.
 */
export const yieldFibers = Effect.yieldNow().pipe(Effect.repeatN(9));

export const it = {
  /** Run effect with TestContext (includes TestClock) */
  effect: <E>(name: string, fn: () => Effect.Effect<void, E, TestEnv>, timeout?: number) =>
    bunTest(
      name,
      () => Effect.runPromise(fn().pipe(Effect.provide(TestContext.TestContext))),
      timeout,
    ),

  /** Run scoped effect with TestContext */
  scoped: <E>(
    name: string,
    fn: () => Effect.Effect<void, E, TestEnv | Scope.Scope>,
    timeout?: number,
  ) =>
    bunTest(
      name,
      () => Effect.runPromise(fn().pipe(Effect.scoped, Effect.provide(TestContext.TestContext))),
      timeout,
    ),

  /** Run effect with real clock (no TestContext) */
  live: <E>(name: string, fn: () => Effect.Effect<void, E, never>, timeout?: number) =>
    bunTest(name, () => Effect.runPromise(fn()), timeout),

  /** Run scoped effect with real clock */
  scopedLive: <E>(name: string, fn: () => Effect.Effect<void, E, Scope.Scope>, timeout?: number) =>
    bunTest(name, () => Effect.runPromise(fn().pipe(Effect.scoped)), timeout),
};

export const test = bunTest;
export const describe = bunDescribe;
export { expect };
