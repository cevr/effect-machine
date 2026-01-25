# Codemap

Quick reference for navigating the codebase.

## Directory Structure

```
src/
├── index.ts           # Public exports
├── Machine.ts         # Core types (Machine, MachineBuilder, Transition)
├── ActorRef.ts        # Actor reference interface
├── ActorSystem.ts     # Actor system service + layer
├── Testing.ts         # Test utilities (simulate, harness, assertions)
├── combinators/       # Machine builder combinators
│   ├── on.ts          # State/event transitions
│   ├── final.ts       # Final state marker
│   ├── always.ts      # Eventless transitions
│   ├── choose.ts      # Guard cascade for events
│   ├── delay.ts       # Delayed event scheduling
│   ├── assign.ts      # Partial state updates (assign, update)
│   ├── invoke.ts      # Async effect with auto-cancel
│   ├── onEnter.ts     # State entry effects
│   └── onExit.ts      # State exit effects
└── internal/
    ├── loop.ts        # Event loop, transition resolver, actor creation
    ├── types.ts       # Internal types (contexts, guards)
    └── getTag.ts      # Tag extraction from constructors

test/
├── Machine.test.ts           # Core machine tests
├── ActorSystem.test.ts       # Actor system tests
├── Testing.test.ts           # Testing utility tests
└── features/
    ├── always-transitions.test.ts
    ├── assign-update.test.ts
    ├── choose.test.ts
    ├── delay.test.ts
    └── guard-composition.test.ts
```

## Key Types

### Machine.ts

```typescript
// Self-reference for sending events
interface MachineRef<Event> {
  send: (event: Event) => Effect.Effect<void>;
}

// Transition with context-based handler
interface Transition<State, Event, R> {
  stateTag: string;
  eventTag: string;
  handler: (ctx: TransitionContext<State, Event>) => State | Effect<State>;
  guard?: (ctx: TransitionContext<State, Event>) => boolean;
  effect?: (ctx: TransitionContext<State, Event>) => Effect<void>;
}

// Eventless transition
interface AlwaysTransition<State, R> {
  stateTag: string;
  handler: (state: State) => State | Effect<State>;
  guard?: (state: State) => boolean;
}

// Machine definition
interface Machine<State, Event, R> {
  initial: State;
  transitions: Transition<State, Event, R>[];
  alwaysTransitions: AlwaysTransition<State, R>[];
  onEnter: StateEffect<State, Event, R>[];
  onExit: StateEffect<State, Event, R>[];
  finalStates: Set<string>;
}
```

### internal/types.ts

```typescript
// Context for transition handlers
type TransitionContext<S, E> = { state: S; event: E };

// Context for state effects (entry/exit)
type StateEffectContext<S, E> = { state: S; self: MachineRef<E> };

// Guard function type
type GuardFn<S, E> = (ctx: TransitionContext<S, E>) => boolean;
```

## Flow: Event Processing

```
1. Event received
   └─ internal/loop.ts: processEvent()

2. Find matching transition
   └─ Iterate transitions in registration order
   └─ Match state tag + event tag
   └─ Evaluate guard (first pass wins)

3. Execute transition
   └─ Run onExit effects for old state
   └─ Compute new state via handler
   └─ Run onEnter effects for new state

4. Apply always transitions
   └─ internal/loop.ts: applyAlways()
   └─ Loop until no guard passes or final state
   └─ Max 100 iterations (infinite loop protection)

5. Update state ref
   └─ Notify subscribers via SubscriptionRef
```

## Flow: Actor Lifecycle

```
1. Spawn actor
   └─ ActorSystem.spawn(id, machine)
   └─ internal/loop.ts: createActor()

2. Create actor infrastructure
   └─ SubscriptionRef for state
   └─ Queue for events
   └─ Event processing fiber

3. Process events
   └─ Dequeue event
   └─ Find + execute transition
   └─ Apply always transitions
   └─ Check final state → stop if reached

4. Cleanup
   └─ Scope finalization interrupts fibers
   └─ ActorSystem removes from registry
```

## Testing Patterns

### simulate (pure)

```typescript
// No actor system, no effects - just state transitions
const result = yield* simulate(machine, [Event.A(), Event.B()]);
// result.states: all intermediate states
// result.finalState: last state
```

### createTestHarness (pure)

```typescript
// Step-by-step testing without side effects
const harness = yield* createTestHarness(machine);
yield* harness.send(Event.A());
const state = yield* harness.getState;
```

### Actor testing (with effects)

```typescript
// Full actor with entry/exit effects, delays
const system = yield* ActorSystemService;
const actor = yield* system.spawn("id", machine);
yield* actor.send(Event.A());
yield* yieldFibers; // Let effects run
const state = yield* actor.state.get;
```

## Guard System

Guards are evaluated in registration order. First passing guard wins.

```typescript
// Inline guard
on(State.A, Event.X, handler, {
  guard: ({ state }) => state.value > 10,
});

// Composed guards
const isAdmin = Guard.make(({ state }) => state.role === "admin");
const isActive = Guard.make(({ state }) => state.active);

on(State.A, Event.X, handler, {
  guard: Guard.and(isAdmin, isActive),
});
```

## Always Transitions

Eventless transitions that fire immediately when state matches.

```typescript
always(State.Calculating, [
  { guard: (s) => s.value >= 70, to: (s) => State.High(s) },
  { guard: (s) => s.value >= 40, to: (s) => State.Medium(s) },
  { otherwise: true, to: (s) => State.Low(s) },
]);
```

Cascade evaluated top-to-bottom. First match wins. `otherwise: true` is the fallback.
