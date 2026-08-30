# React example

This application starts an actor through an Effect Atom. React Suspense owns the loading boundary.

The application uses three selected Atoms. A count change renders only the count view. A label change renders only the label view. A state-tag change renders only the status view and the affected screen tree.

Motion keeps the old screen mounted for its exit animation. The terminal machine state retains the displayed values. The component does not keep a second copy of machine state.

Run it:

```bash
bun run example:react
```

Run its build and render-count test:

```bash
bun run --cwd examples/react gate
```
