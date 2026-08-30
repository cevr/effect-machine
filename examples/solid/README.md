# Solid example

This application starts an actor through an Effect Atom resource. Solid Suspense owns the loading boundary.

The application uses selected Atoms for the count, label, and state tag. A change runs only the computation that reads the changed selection.

The transition group keeps the old screen mounted for its exit animation. The terminal machine state retains the displayed values. The component does not keep a second copy of machine state.

Run it:

```bash
bun run example:solid
```

Run its build and computation-count test:

```bash
bun run --cwd examples/solid gate
```
