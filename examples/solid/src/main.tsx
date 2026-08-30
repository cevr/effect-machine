import { render } from "solid-js/web";

import { makeCounterActorAtom } from "../../counter.js";
import { App } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (rootElement !== null) {
  const dispose = render(() => <App actorAtom={makeCounterActorAtom()} />, rootElement);
  import.meta.hot?.dispose(() => {
    dispose();
  });
}
