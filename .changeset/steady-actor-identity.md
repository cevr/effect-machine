---
"effect-machine": patch
---

Run actor startup once across concurrent and repeated calls. Preserve terminal lifecycle when start is called after stop. Keep replacement actors registered when an earlier owner scope closes.
