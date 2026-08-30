/**
 * Event advancement policy shared by live and offline machine execution.
 *
 * Owns postponed event order, cascading drain, and terminal state handling.
 * Callers supply the effects that execute one event.
 *
 * @internal
 */
import { Effect } from "effect";

export interface AdvancementStep<S, A> {
  readonly state: S;
  readonly stateChanged: boolean;
  readonly shouldStop: boolean;
  readonly value: A;
}

export interface PostponedStep<I, A> {
  readonly input: I;
  readonly value: A;
}

export interface EventAdvancementOptions<S, I, A, R> {
  readonly initial: S;
  readonly isFinal: (state: S) => boolean;
  readonly shouldPostpone: (state: S, input: I) => boolean;
  readonly postpone: (state: S, input: I) => Effect.Effect<PostponedStep<I, A>, never, R>;
  readonly process: (
    state: S,
    input: I,
    draining: boolean,
  ) => Effect.Effect<AdvancementStep<S, A>, never, R>;
  readonly discard?: (input: I) => Effect.Effect<void, never, R>;
}

export interface AdvancementResult<S, A> {
  readonly state: S;
  readonly value: A;
  readonly stopped: boolean;
  readonly postponed: boolean;
}

export const makeEventAdvancement = <S, I, A, R>(options: EventAdvancementOptions<S, I, A, R>) => {
  let state = options.initial;
  let stopped = options.isFinal(state);
  const postponed: I[] = [];

  const advance = Effect.fn("effect-machine.eventAdvancement.advance")(function* (input: I) {
    const postponedStep = (entry: I) => options.postpone(state, entry);

    if (options.shouldPostpone(state, input)) {
      const result = yield* postponedStep(input);
      postponed.push(result.input);
      return {
        state,
        value: result.value,
        stopped,
        postponed: true,
      } satisfies AdvancementResult<S, A>;
    }

    const first = yield* options.process(state, input, false);
    state = first.state;
    stopped = first.shouldStop || options.isFinal(state);

    let stateChanged = first.stateChanged;
    while (!stopped && stateChanged && postponed.length > 0) {
      stateChanged = false;
      const drained = postponed.splice(0);

      for (const entry of drained) {
        if (options.shouldPostpone(state, entry)) {
          postponed.push(entry);
          continue;
        }

        const step = yield* options.process(state, entry, true);
        state = step.state;
        stopped = step.shouldStop || options.isFinal(state);
        stateChanged = stateChanged || step.stateChanged;
        if (stopped) break;
      }
    }

    return {
      state,
      value: first.value,
      stopped,
      postponed: false,
    } satisfies AdvancementResult<S, A>;
  });

  const close = Effect.fn("effect-machine.eventAdvancement.close")(function* () {
    if (options.discard !== undefined) {
      for (const input of postponed) {
        yield* options.discard(input);
      }
    }
    postponed.length = 0;
  });

  return {
    advance,
    close,
    get state(): S {
      return state;
    },
    get stopped(): boolean {
      return stopped;
    },
  };
};
