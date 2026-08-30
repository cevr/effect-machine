# Cluster entities

Import cluster support from its subpath:

```ts
import { EntityMachine, toEntity } from "effect-machine/cluster";
```

Create an entity definition from a machine:

```ts
const OrderEntity = toEntity(orderMachine, { type: "Order" });
```

Build the layer:

```ts
const OrderEntityLayer = EntityMachine.layer(OrderEntity, orderMachine, {
  initializeState: (entityId) => OrderState.Pending({ orderId: entityId }),
  persistence: { strategy: "journal" },
});
```

An input machine needs an entity-ID adapter:

```ts
EntityMachine.layer(OrderEntity, inputOrderMachine, {
  input: (entityId) => ({ orderId: entityId }),
});
```

The generated entity exposes send, ask, state, and state-watch RPC operations. The client wrapper exposes typed `send`, `ask`, `snapshot`, `watch`, and `waitFor` operations.

Use snapshot persistence for periodic state checkpoints. Use journal persistence when each accepted event must be durable before the RPC completes. A journal append failure defects the entity. Cluster retry can then reactivate it from persisted data.
