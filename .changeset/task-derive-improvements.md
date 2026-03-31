---
"effect-machine": patch
---

- feat: union-level `derive` on State and Event schemas — dispatches by `_tag`, preserves specific variant subtype
- fix: `derive` partial keys not in target variant are now silently dropped
- fix: `.task()` `onSuccess` is now optional — omit when task returns Event directly
