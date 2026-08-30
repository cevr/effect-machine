import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { makeCounterActorAtom } from "../../counter.js";
import { App } from "./app.js";

const rootElement = document.getElementById("root");

if (rootElement !== null) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <App actorAtom={makeCounterActorAtom()} />
    </StrictMode>,
  );
  import.meta.hot?.dispose(() => {
    root.unmount();
  });
}
