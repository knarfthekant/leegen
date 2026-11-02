import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { setBackend, type Backend } from "./backend";
import { createServerBackend } from "./backend/server";
import "./lib/monaco";
import { App } from "./App";
import "./styles.css";

// The edition is chosen at build time: `vite build` (server) or `vite build --mode browser`.
async function chooseBackend(): Promise<Backend> {
  if (import.meta.env.VITE_LEETCLAUDE_EDITION === "browser") {
    const { createBrowserBackend } = await import("./backend/browser");
    return createBrowserBackend();
  }
  return createServerBackend();
}

const root = createRoot(document.getElementById("root")!);
chooseBackend().then(
  (backend) => {
    setBackend(backend);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  },
  (e) => {
    root.render(
      <main className="list-main">
        <div className="soft-alert tone-fail">
          <div className="soft-alert-body">
            <strong>leetclaude could not start</strong>
            <pre>{String(e?.message ?? e)}</pre>
          </div>
        </div>
      </main>,
    );
  },
);
