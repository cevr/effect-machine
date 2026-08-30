# Core examples

These examples are small programs. Their tests run every program through the public package imports.

Use [`basic.ts`](./src/basic.ts) first. Then select a pattern from the root [example matrix](../README.md).

The programs do not add a machine-specific action layer. Pure state changes stay in transition handlers. External work stays in Effect services, tasks, state-scoped Effects, or actor-scoped background Effects.

Run the package gate:

```bash
bun run --cwd examples/core gate
```
