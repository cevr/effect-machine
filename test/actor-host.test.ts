// @effect-diagnostics strictEffectProvide:off - tests are entry points
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect";
import { describe, expect, it, yieldFibers } from "effect-bun-test";

import {
  ActorHost,
  ActorSystemDefault,
  ActorSystemService,
  Event,
  Machine,
  State,
} from "../src/index.js";

const ChildState = State({ Ready: { value: Schema.String }, Done: {} });
const ChildEvent = Event({ Finish: {} });
const child = Machine.make({
  state: ChildState,
  event: ChildEvent,
  initial: (input: { value: string }) => ChildState.Ready(input),
})
  .on(ChildState.Ready, ChildEvent.Finish, () => ChildState.Done)
  .final(ChildState.Done);

class Label extends Context.Service<Label, { readonly value: string }>()(
  "effect-machine/test/actor-host.test/Label",
) {}

const ownerScope = Effect.acquireRelease(Scope.make(), (scope) => Scope.close(scope, Exit.void));

describe("ActorHost", () => {
  it.scoped(
    "is lazy, uses request input and captured services, and survives consumer scope close",
    () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const host = yield* ActorHost.make({
          identity: (input: { session: object; value: string }) => input.session,
          spawn: (input) =>
            Effect.gen(function* () {
              const label = yield* Label;
              return yield* system.spawn("child", child, {
                input: { value: `${label.value}:${input.value}` },
              });
            }),
        }).pipe(Effect.provideService(Label, { value: "root" }));
        const session = {};
        const owner = yield* ownerScope;
        const hosted = yield* host
          .host({ session, value: "old" })
          .pipe(Scope.provide(owner), Effect.forkScoped);
        yield* yieldFibers;
        expect(Option.isNone(yield* system.get("child"))).toBe(true);
        const [first, second] = yield* Effect.all(
          [
            Effect.scoped(host.acquire({ session, value: "current" })),
            host.acquire({ session, value: "current" }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.provideService(Label, { value: "consumer" }));
        expect(first).toBe(second);
        expect(yield* Fiber.join(hosted)).toBe(first);
        expect(yield* first.snapshot).toEqual(ChildState.Ready({ value: "root:current" }));
        expect(Option.isSome(yield* system.get("child"))).toBe(true);
        yield* Scope.close(owner, Exit.void);
        expect(Option.isNone(yield* system.get("child"))).toBe(true);
        expect((yield* first.call(ChildEvent.Finish)).transitioned).toBe(false);
        const nextOwner = yield* ownerScope;
        const nextHosted = yield* host
          .host({ session, value: "unused" })
          .pipe(Scope.provide(nextOwner), Effect.forkScoped);
        const next = yield* host.acquire({ session, value: "next" });
        expect(next).not.toBe(first);
        expect(yield* Fiber.join(nextHosted)).toBe(next);
        expect(yield* next.snapshot).toEqual(ChildState.Ready({ value: "root:next" }));
      }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("keeps actual recovery running when an acquiring consumer cancels", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) =>
          system.spawn("recovering", child, {
            input: { value },
            lifecycle: {
              recovery: {
                resolve: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(Option.none()),
                  ),
              },
            },
          }),
      });
      const owner = yield* ownerScope;
      const hosted = yield* host.host("session").pipe(Scope.provide(owner), Effect.forkScoped);
      const first = yield* host.acquire("session").pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      const second = yield* host.acquire("session").pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      const actor = yield* Fiber.join(second);
      expect(yield* Fiber.join(hosted)).toBe(actor);
      expect(yield* actor.snapshot).toEqual(ChildState.Ready({ value: "session" }));
      yield* Scope.close(owner, Exit.void);
      expect(Option.isNone(yield* system.get("recovering"))).toBe(true);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("closes pending recovery and all waiting acquisitions with its owner", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) =>
          system.spawn("pending", child, {
            input: { value },
            lifecycle: {
              recovery: {
                resolve: () =>
                  Effect.acquireUseRelease(
                    Deferred.succeed(started, undefined),
                    () => Effect.never,
                    () => Deferred.succeed(released, undefined),
                  ),
              },
            },
          }),
      });
      const owner = yield* ownerScope;
      const hosted = yield* host
        .host("session")
        .pipe(Scope.provide(owner), Effect.exit, Effect.forkScoped);
      const acquisition = yield* host.acquire("session").pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* Scope.close(owner, Exit.void);
      expect(yield* Deferred.isDone(released)).toBe(true);
      const hostExit = yield* Fiber.join(hosted);
      expect(Exit.isFailure(hostExit)).toBe(true);
      if (Exit.isFailure(hostExit)) expect(Cause.hasInterruptsOnly(hostExit.cause)).toBe(true);
      expect((yield* Fiber.join(acquisition))._tag).toBe("ActorHostClosedError");
      expect(Option.isNone(yield* system.get("pending"))).toBe(true);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("rejects overlapping hosts and closes unmatched consumers with the service", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const serviceScope = yield* ownerScope;
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) => system.spawn("child", child, { input: { value } }),
      }).pipe(Scope.provide(serviceScope));
      const owner = yield* ownerScope;
      const hosted = yield* host
        .host("first")
        .pipe(Scope.provide(owner), Effect.exit, Effect.forkScoped);
      yield* yieldFibers;
      const otherOwner = yield* ownerScope;
      const duplicate = yield* host.host("second").pipe(Scope.provide(otherOwner), Effect.flip);
      expect(duplicate._tag).toBe("ActorHostOccupiedError");
      const unmatched = yield* host.acquire("other").pipe(Effect.flip, Effect.forkScoped);
      yield* Scope.close(serviceScope, Exit.void);
      expect((yield* Fiber.join(unmatched))._tag).toBe("ActorHostClosedError");
      const hostExit = yield* Fiber.join(hosted);
      expect(Exit.isFailure(hostExit)).toBe(true);
      if (Exit.isFailure(hostExit)) expect(Cause.hasInterruptsOnly(hostExit.cause)).toBe(true);
      expect((yield* host.acquire("first").pipe(Effect.flip))._tag).toBe("ActorHostClosedError");
      expect((yield* host.host("first").pipe(Scope.provide(otherOwner), Effect.flip))._tag).toBe(
        "ActorHostClosedError",
      );
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("replaces the child on native parent state reentry and stops it on parent close", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) => system.spawn("state-child", child, { input: { value } }),
      });
      const ParentState = State({ Inactive: {}, Active: {} });
      const ParentEvent = Event({ Enter: {}, Leave: {}, Restart: {} });
      const parentMachine = Machine.make({
        state: ParentState,
        event: ParentEvent,
        initial: ParentState.Inactive,
      })
        .on(ParentState.Inactive, ParentEvent.Enter, () => ParentState.Active)
        .on(ParentState.Active, ParentEvent.Leave, () => ParentState.Inactive)
        .reenter(ParentState.Active, ParentEvent.Restart, () => ParentState.Active)
        .spawn(ParentState.Active, () => host.host("session").pipe(Effect.orDie, Effect.asVoid));
      const parent = yield* Machine.scoped(system.spawn("parent", parentMachine));
      yield* parent.call(ParentEvent.Enter);
      yield* parent.call(ParentEvent.Leave);
      expect(Option.isNone(yield* system.get("state-child"))).toBe(true);
      const pending = yield* host.acquire("session").pipe(Effect.forkScoped);
      yield* parent.call(ParentEvent.Enter);
      const first = yield* Fiber.join(pending);
      yield* parent.call(ParentEvent.Restart);
      const second = yield* host.acquire("session");
      expect(second).not.toBe(first);
      expect((yield* first.call(ChildEvent.Finish)).transitioned).toBe(false);
      yield* parent.call(ParentEvent.Leave);
      expect(Option.isNone(yield* system.get("state-child"))).toBe(true);
      yield* parent.call(ParentEvent.Enter);
      const third = yield* host.acquire("session");
      expect(third).not.toBe(second);
      yield* parent.stop;
      expect(Option.isNone(yield* system.get("state-child"))).toBe(true);
      expect((yield* third.call(ChildEvent.Finish)).transitioned).toBe(false);
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped(
    "shares typed startup failure and stops a live actor when its host service closes",
    () =>
      Effect.gen(function* () {
        const system = yield* ActorSystemService;
        const existing = yield* Machine.scoped(
          system.spawn("shared", child, { input: { value: "existing" } }),
        );
        const serviceScope = yield* ownerScope;
        const host = yield* ActorHost.make({
          identity: (input: string) => input,
          spawn: (value) => system.spawn("shared", child, { input: { value } }),
        }).pipe(Scope.provide(serviceScope));
        const owner = yield* ownerScope;
        const hosted = yield* host
          .host("session")
          .pipe(Scope.provide(owner), Effect.flip, Effect.forkScoped);
        const failure = yield* host.acquire("session").pipe(Effect.flip);
        expect(failure._tag).toBe("DuplicateActorError");
        expect(yield* Fiber.join(hosted)).toBe(failure);
        expect(yield* host.acquire("session").pipe(Effect.flip)).toBe(failure);
        yield* Scope.close(owner, Exit.void);
        yield* existing.stop;
        const nextOwner = yield* ownerScope;
        const nextHosted = yield* host
          .host("session")
          .pipe(Scope.provide(nextOwner), Effect.forkScoped);
        const actor = yield* host.acquire("session");
        expect(yield* Fiber.join(nextHosted)).toBe(actor);
        yield* Scope.close(serviceScope, Exit.void);
        expect(Option.isNone(yield* system.get("shared"))).toBe(true);
        expect((yield* actor.call(ChildEvent.Finish)).transitioned).toBe(false);
      }).pipe(Effect.provide(ActorSystemDefault)),
  );
  it.scoped("starts actors returned by Machine.spawn before publishing them", () =>
    Effect.gen(function* () {
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) => Machine.spawn(child, { input: { value } }),
      });
      const owner = yield* ownerScope;
      const hosted = yield* host.host("direct").pipe(Scope.provide(owner), Effect.forkScoped);
      const actor = yield* host.acquire("direct");
      expect((yield* SubscriptionRef.get(actor.lifecycle))._tag).toBe("Active");
      expect(yield* Fiber.join(hosted)).toBe(actor);
      expect((yield* actor.call(ChildEvent.Finish)).transitioned).toBe(true);
    }),
  );
  it.scoped("ends a pending native state acquisition with a typed error and permits reentry", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) =>
          system.spawn("native-recovery", child, {
            input: { value },
            lifecycle: {
              recovery: {
                resolve: () =>
                  Deferred.succeed(started, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.as(Option.none()),
                  ),
              },
            },
          }),
      });
      const ParentState = State({ Inactive: {}, Active: {} });
      const ParentEvent = Event({ Enter: {}, Leave: {} });
      const parentMachine = Machine.make({
        state: ParentState,
        event: ParentEvent,
        initial: ParentState.Inactive,
      })
        .on(ParentState.Inactive, ParentEvent.Enter, () => ParentState.Active)
        .on(ParentState.Active, ParentEvent.Leave, () => ParentState.Inactive)
        .spawn(ParentState.Active, () => host.host("session").pipe(Effect.orDie, Effect.asVoid));
      const parent = yield* Machine.scoped(system.spawn("native-parent", parentMachine));
      yield* parent.call(ParentEvent.Enter);
      const pending = yield* host.acquire("session").pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(started);
      yield* parent.call(ParentEvent.Leave);
      expect((yield* Fiber.join(pending))._tag).toBe("ActorHostClosedError");
      expect(Option.isNone(yield* system.get("native-recovery"))).toBe(true);
      expect((yield* parent.call(ParentEvent.Enter)).transitioned).toBe(true);
      yield* Deferred.succeed(release, undefined);
      const actor = yield* host.acquire("session");
      expect((yield* actor.snapshot)._tag).toBe("Ready");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );

  it.scoped("fails acquisitions during actor cleanup and rejects an overlapping generation", () =>
    Effect.gen(function* () {
      const system = yield* ActorSystemService;
      const stopping = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleanupChild = Machine.make({
        state: ChildState,
        event: ChildEvent,
        initial: (input: { value: string }) => ChildState.Ready(input),
      }).background(() =>
        Effect.addFinalizer(() =>
          Deferred.succeed(stopping, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      const host = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) => system.spawn("cleanup", cleanupChild, { input: { value } }),
      });
      const owner = yield* ownerScope;
      yield* host.host("session").pipe(Scope.provide(owner), Effect.forkScoped);
      yield* host.acquire("session");
      const closing = yield* Scope.close(owner, Exit.void).pipe(Effect.forkScoped);
      yield* Deferred.await(stopping);
      expect((yield* host.acquire("session").pipe(Effect.flip))._tag).toBe("ActorHostClosedError");
      const nextOwner = yield* ownerScope;
      expect((yield* host.host("session").pipe(Scope.provide(nextOwner), Effect.flip))._tag).toBe(
        "ActorHostOccupiedError",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      yield* host.host("session").pipe(Scope.provide(nextOwner), Effect.forkScoped);
      const next = yield* host.acquire("session");
      expect((yield* next.snapshot)._tag).toBe("Ready");
    }).pipe(Effect.provide(ActorSystemDefault)),
  );
  it.scoped("preserves a factory error from another closed host", () =>
    Effect.gen(function* () {
      const innerScope = yield* ownerScope;
      const inner = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (value) => Machine.spawn(child, { input: { value } }),
      }).pipe(Scope.provide(innerScope));
      yield* Scope.close(innerScope, Exit.void);
      const outer = yield* ActorHost.make({
        identity: (input: string) => input,
        spawn: (input) => inner.acquire(input),
      });
      const owner = yield* ownerScope;
      const hosted = yield* outer
        .host("session")
        .pipe(Scope.provide(owner), Effect.flip, Effect.forkScoped);
      const error = yield* outer.acquire("session").pipe(Effect.flip);
      expect(error._tag).toBe("ActorHostClosedError");
      expect(yield* Fiber.join(hosted)).toBe(error);
    }),
  );
});
