---
"effect-machine": patch
---

Start state and background Effects eagerly so their synchronous setup completes before actor state becomes visible. A task that completes in its first Effect slice can now enqueue its result before a caller sends its next event. A suspending Inspector can delay this setup because inspection remains ordered and awaited.
