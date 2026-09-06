---
"effect-machine": patch
---

Stop pending actor startup before closing its runtime. Wait for recovery cleanup even when a stop caller cancels its wait. Finish shutdown owner creation and cache publication before accepting caller cancellation. Preserve terminal lifecycle during initial startup and supervised activation. Keep synchronous host sends ready when startup completes. Preserve recovery cleanup errors and prevent recovery fallbacks from swallowing self-stop.
