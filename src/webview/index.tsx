import { createRoot } from "react-dom/client";

import { App } from "./app";

const root = document.querySelector("#root");
if (!(root instanceof HTMLElement)) {
  throw new Error("Missing webview root");
}

createRoot(root).render(<App />);
