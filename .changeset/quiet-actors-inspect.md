---
"effect-machine": patch
---

Keep actor-local inspection separate from ambient inspection when actors spawn nested actors or restart. Route task inspection through the same actor dispatcher for local, system, and cluster inspectors.
