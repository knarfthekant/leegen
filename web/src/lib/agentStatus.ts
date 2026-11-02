import { useEffect, useState } from "react";
import { getBackend } from "../backend";
import type { AgentStatus } from "../contracts/generated";

/** Share one activity state between the floating badge and the browser's Codex guide. */
export function useAgentStatus(): AgentStatus | null {
  const [status, setStatus] = useState<AgentStatus | null>(null);

  useEffect(() => {
    const backend = getBackend();
    let disposed = false;
    let revision = 0;
    const unsubscribe = backend.subscribe((event) => {
      if (event.type !== "agent_status_changed") return;
      revision++;
      setStatus(event.agent_status);
    });
    const refresh = () => {
      const started = revision;
      void backend.getAgentStatus().then((value) => {
        // An event received during the request is more current than its snapshot.
        if (!disposed && revision === started) setStatus(value);
      }).catch(() => { /* Service connectivity is shown by the topbar. */ });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (status?.expires_at == null) return;
    const timer = window.setTimeout(() => setStatus(null), Math.max(0, status.expires_at * 1000 - Date.now()));
    return () => window.clearTimeout(timer);
  }, [status]);

  return status && status.status !== "idle" && status.expires_at !== null && status.expires_at * 1000 > Date.now()
    ? status : null;
}
