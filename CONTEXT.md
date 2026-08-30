# Effect Machine

Effect Machine defines state machines and runs them as actors.

## Language

**Machine**:
A definition of valid states, events, transitions, and state behavior.
_Avoid_: Workflow, process

**Actor**:
A running instance of a machine with its own state and event mailbox.
_Avoid_: Machine instance, worker

**Actor client**:
A Promise and callback facade for code that does not run inside Effect.
_Avoid_: Sync actor, unsafe actor

**State**:
The current domain value of an actor.
_Avoid_: Status

**Event**:
A value that an actor can process to select a transition.
_Avoid_: Message, action

**Postponed event**:
An event that an actor keeps until its state permits processing.
_Avoid_: Deferred event, delayed event

**Input**:
An immutable value that creates the initial state of one actor.
_Avoid_: Initial context, actor context

**Output**:
A domain value that an actor produces when it reaches a final state.
_Avoid_: Final context, result state

**Requirement**:
An Effect service that a machine needs at runtime.
_Avoid_: Machine dependency, injected context

**Task**:
State-owned Effect work that sends a success or failure event.
_Avoid_: Invoked promise, async action

**State-owned Effect**:
An Effect resource that starts on state entry and stops on state exit.
_Avoid_: Callback actor, entry action

**Background Effect**:
An Effect resource that lives for the actor lifetime.
_Avoid_: Global action, detached task

**Final state**:
A state that stops the actor and produces output.
_Avoid_: Completed context

**Parent actor**:
An actor that owns child actors and routes a larger interactive flow.
_Avoid_: Orchestrator action
