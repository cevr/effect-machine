# Effect Machine

Effect Machine defines state machines and runs them as actors.

## Language

**Machine**:
A definition of valid states, events, transitions, and state behavior.
_Avoid_: Workflow, process

**Actor**:
A running instance of a machine with its own state and event mailbox.
_Avoid_: Machine instance, worker

**State**:
The current domain value of an actor.
_Avoid_: Status

**Event**:
A value that an actor can process to select a transition.
_Avoid_: Message, action

**Postponed event**:
An event that an actor keeps until its state permits processing.
_Avoid_: Deferred event, delayed event
