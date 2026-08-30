import { RegistryProvider, useAtomSet, useAtomSuspense, useAtomValue } from "@effect/atom-react";
import { AnimatePresence, motion } from "motion/react";
import { Suspense, useMemo } from "react";

import type { CounterActorAtom, CounterAtoms } from "@effect-machine/examples-shared/counter";
import { CounterEvent, makeCounterAtoms } from "@effect-machine/examples-shared/counter";

export interface RenderCounters {
  readonly count?: (() => void) | undefined;
  readonly label?: (() => void) | undefined;
  readonly status?: (() => void) | undefined;
  readonly canIncrement?: (() => void) | undefined;
}

const Count = (props: { readonly atoms: CounterAtoms; readonly onRender?: () => void }) => {
  props.onRender?.();
  const count = useAtomValue(props.atoms.count);
  return <output aria-label="Count">{count}</output>;
};

const Label = (props: { readonly atoms: CounterAtoms; readonly onRender?: () => void }) => {
  props.onRender?.();
  const label = useAtomValue(props.atoms.label);
  return <h1>{label}</h1>;
};

const Controls = (props: {
  readonly atoms: CounterAtoms;
  readonly onCanIncrementRender?: () => void;
}) => {
  props.onCanIncrementRender?.();
  const send = useAtomSet(props.atoms.state);
  const canIncrement = useAtomSuspense(props.atoms.canIncrement).value;
  return (
    <div>
      <button type="button" disabled={!canIncrement} onClick={() => send(CounterEvent.Increment)}>
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

const AnimatedCounter = (props: {
  readonly atoms: CounterAtoms;
  readonly renders?: RenderCounters | undefined;
}) => {
  props.renders?.status?.();
  const status = useAtomValue(props.atoms.status);
  return (
    <>
      <output aria-label="Status">{status}</output>
      <AnimatePresence>
        {status === "Active" && (
          <motion.main
            key="counter"
            data-testid="counter-screen"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <Label atoms={props.atoms} onRender={props.renders?.label} />
            <Count atoms={props.atoms} onRender={props.renders?.count} />
            <Controls atoms={props.atoms} onCanIncrementRender={props.renders?.canIncrement} />
          </motion.main>
        )}
      </AnimatePresence>
    </>
  );
};

const SuspendedCounter = (props: {
  readonly actorAtom: CounterActorAtom;
  readonly renders?: RenderCounters | undefined;
}) => {
  const actor = useAtomSuspense(props.actorAtom).value;
  const atoms = useMemo(() => makeCounterAtoms(actor), [actor]);
  return <AnimatedCounter atoms={atoms} renders={props.renders} />;
};

export const App = (props: {
  readonly actorAtom: CounterActorAtom;
  readonly renders?: RenderCounters | undefined;
}) => (
  <RegistryProvider>
    <Suspense fallback={<p>Starting actor…</p>}>
      <SuspendedCounter actorAtom={props.actorAtom} renders={props.renders} />
    </Suspense>
  </RegistryProvider>
);
