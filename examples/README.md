# Examples

This directory is a Bun workspace. Each package uses the repository source. The root gate runs every example package.

## Example matrix

| Pattern                                     | Example                                                                | What it proves                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Schema-first state and guarded edges        | [`core/src/basic.ts`](./core/src/basic.ts)                             | Typed input, ordered guards, multi-state edges, and typed output         |
| Effect transition predicate                 | [`core/src/effect-guard.ts`](./core/src/effect-guard.ts)               | `.when()` uses captured services in `actor.can` and queued transitions   |
| Effect services and tasks                   | [`core/src/services-and-tasks.ts`](./core/src/services-and-tasks.ts)   | Requirements remain in the Effect context and task results become events |
| Machine composition                         | [`core/src/composition.ts`](./core/src/composition.ts)                 | `Machine.run` composes with `Effect.flatMap`                             |
| Actor topology                              | [`core/src/actor-system.ts`](./core/src/actor-system.ts)               | A named root actor owns a state-scoped child actor                       |
| Hardware or host input                      | [`core/src/hardware-navigation.ts`](./core/src/hardware-navigation.ts) | An Effect `Stream` adapter maps host input to machine events             |
| Recovery and durability                     | [`core/src/persistence.ts`](./core/src/persistence.ts)                 | A new actor recovers the last committed state                            |
| Supervision                                 | [`core/src/supervision.ts`](./core/src/supervision.ts)                 | A state-owned Effect defects once and restarts within a budget           |
| Inspection                                  | [`core/src/inspection.ts`](./core/src/inspection.ts)                   | Events, transitions, and named guard results are observable              |
| Framework-neutral Atom                      | [`core/src/atom.ts`](./core/src/atom.ts)                               | Writable selectors suppress unrelated updates                            |
| React, Suspense, selectors, and Motion      | [`react/src/app.tsx`](./react/src/app.tsx)                             | Atom-owned actor startup and retained exit data                          |
| Solid, Suspense, selectors, and transitions | [`solid/src/app.tsx`](./solid/src/app.tsx)                             | Fine-grained selected computations and retained exit data                |

The hardware, actor-system, and UI examples come from patterns found in a large kiosk application. They show the small reusable form of root routing, state-owned device listeners, named actors, selector-heavy views, and exit animation retention.

## Commands

Run every example gate from the repository root:

```bash
bun run examples:gate
```

Run one package:

```bash
bun run --cwd examples/core gate
bun run --cwd examples/react gate
bun run --cwd examples/solid gate
```

Start a browser example:

```bash
bun run example:react
bun run example:solid
```
