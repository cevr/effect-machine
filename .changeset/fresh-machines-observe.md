---
"effect-machine": minor
---

Add `.when()` transitions with Boolean or Effect predicates, reactive guard-aware `can`, a non-Effect `actor.client` facade, Effectful transition handlers with a `never` error contract, stable eventless transitions, typed machine input and output, scoped `Machine.run` composition, cluster input adapters, actor lifecycle observation, retained latest transitions, and automatic actor system cleanup after terminal exits.

Add a Bun examples workspace with tested core, React, and Solid implementations. Add guides for Effect composition, actor topology, async work, Atom selectors, animation retention, persistence, supervision, inspection, testing, cluster entities, and XState migration.

Make task failure handlers receive the typed Effect error. Keep defects in the actor failure and supervision path. Add named transition-operation inspection. Add actor generation to every inspection event.
