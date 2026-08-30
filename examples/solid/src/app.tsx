import { RegistryProvider, useAtomResource, useAtomSet, useAtomValue } from "@effect/atom-solid";
import { Duration, Effect } from "effect";
import { createEffect, createMemo, Show, Suspense } from "solid-js";
import { Transition } from "solid-transition-group";

import type { CounterActorAtom, CounterAtoms } from "../../counter.js";
import { CounterEvent, makeCounterAtoms } from "../../counter.js";

export interface ComputationCounters {
  readonly count?: (() => void) | undefined;
  readonly label?: (() => void) | undefined;
  readonly status?: (() => void) | undefined;
}

const Count = (props: { readonly atoms: CounterAtoms; readonly onCompute?: () => void }) => {
  const count = useAtomValue(() => props.atoms.count);
  createEffect(() => {
    count();
    props.onCompute?.();
  });
  return <output aria-label="Count">{count()}</output>;
};

const Label = (props: { readonly atoms: CounterAtoms; readonly onCompute?: () => void }) => {
  const label = useAtomValue(() => props.atoms.label);
  createEffect(() => {
    label();
    props.onCompute?.();
  });
  return <h1>{label()}</h1>;
};

const Controls = (props: { readonly atoms: CounterAtoms }) => {
  const send = useAtomSet(() => props.atoms.state);
  return (
    <div>
      <button type="button" onClick={() => send(CounterEvent.Increment)}>
        Increment
      </button>
      <button type="button" onClick={() => send(CounterEvent.Rename({ label: "Renamed" }))}>
        Rename
      </button>
      <button type="button" onClick={() => send(CounterEvent.Finish)}>
        Finish
      </button>
    </div>
  );
};

const exitDuration = Duration.millis(200);

const completeExit = (_element: Element, done: () => void): void => {
  Effect.runFork(Effect.delay(Effect.sync(done), exitDuration));
};

const AnimatedCounter = (props: {
  readonly atoms: CounterAtoms;
  readonly computations?: ComputationCounters | undefined;
}) => {
  const status = useAtomValue(() => props.atoms.status);
  createEffect(() => {
    status();
    props.computations?.status?.();
  });
  return (
    <>
      <output aria-label="Status">{status()}</output>
      <Transition name="counter" onExit={completeExit}>
        <Show when={status() === "Active"}>
          <main data-testid="counter-screen">
            <Label atoms={props.atoms} onCompute={props.computations?.label} />
            <Count atoms={props.atoms} onCompute={props.computations?.count} />
            <Controls atoms={props.atoms} />
          </main>
        </Show>
      </Transition>
    </>
  );
};

const SuspendedCounter = (props: {
  readonly actorAtom: CounterActorAtom;
  readonly computations?: ComputationCounters | undefined;
}) => {
  const [actor] = useAtomResource(() => props.actorAtom);
  const atoms = createMemo(() => {
    const value = actor();
    if (value === undefined) return undefined;
    return makeCounterAtoms(value);
  });
  return (
    <Show when={atoms()}>
      {(value) => <AnimatedCounter atoms={value()} computations={props.computations} />}
    </Show>
  );
};

export const App = (props: {
  readonly actorAtom: CounterActorAtom;
  readonly computations?: ComputationCounters | undefined;
}) => (
  <RegistryProvider>
    <Suspense fallback={<p>Starting actor…</p>}>
      <SuspendedCounter actorAtom={props.actorAtom} computations={props.computations} />
    </Suspense>
  </RegistryProvider>
);
