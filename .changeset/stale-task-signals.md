---
"effect-machine": patch
---

A task's success or failure event and a `.timeout` event now belong to the state entry that started them. The actor drops such an event when that entry has ended before the event leaves the mailbox. Before this change, a task that completed (or a timer that fired) while another event left the state queued its event behind that event, and a later entry of the same state processed it: after `.reenter`, or after a round trip such as `A -> B -> A`. Handlers had to compare a lease or an entry id in the event with the state to ignore it. An entry ends on a change of state tag or on `.reenter`. A same-tag `.on` transition keeps the entry, so its task and timer events still arrive. A stale event is dropped before any hook sees it, and it is never postponed. Events that a `.spawn` handler sends with `self.send` are not owned and are delivered as before.
