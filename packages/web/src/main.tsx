import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App.js";
import { useConnectionStore } from "./connections/store.js";
import { useRootStore } from "./store/root.js";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("No #root element found in document");
}

const root = createRoot(rootEl);

void useConnectionStore.getState().hydrate().then(() => {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>
  );
});

window.addEventListener("focus", () => {
  const conn = useRootStore.getState().getActiveConnection();
  if (!conn) return;
});
