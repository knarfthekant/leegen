// The server edition: REST under /api and a listen-only WebSocket at /api/ws.

import type { CustomTest, Problem, RunResult, WorkspaceState } from "../lib/api";
import type { AgentStatus } from "../contracts/generated";
import type { Backend, BackendEvent, BackendStatus, ExecutorListing, ProblemListing, SessionReport } from "./types";

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* not json */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json() as Promise<T>;
}

const enc = encodeURIComponent;

export function createServerBackend(base = ""): Backend {
  const api = `${base}/api`;
  const listeners = new Set<(e: BackendEvent) => void>();
  const statusListeners = new Set<() => void>();
  let socket: WebSocket | null = null;
  let retry = 0;
  let live: boolean | null = null;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let status: BackendStatus = {
    services: [
      { id: "server", label: "Server", state: "connecting", detail: "Checking the leegen server…" },
      { id: "mcp", label: "MCP", state: "connecting", detail: "Checking the MCP service…" },
      { id: "updates", label: "Live updates", state: "connecting", detail: "Opening the WebSocket connection…" },
    ],
  };

  const update = (services: BackendStatus["services"]) => {
    status = { services };
    statusListeners.forEach((l) => l());
  };

  const checkHealth = async () => {
    if (checking) return;
    checking = true;
    try {
      const res = await fetch(`${api}/status`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Server status: ${res.status}`);
      const health = await res.json() as { server: boolean; mcp: boolean };
      update(status.services.map((s) => {
        if (s.id === "server") return {
          ...s, state: health.server === true ? "online" : "offline",
          detail: health.server === true ? "The leegen API is reachable." : "The leegen API is offline.",
        };
        if (s.id === "mcp") return {
          ...s, state: health.mcp === true ? "online" : "offline",
          detail: health.mcp === true
            ? `MCP is ready at ${new URL(`${base}/mcp`, location.href).href}. Agents can connect here.`
            : "The MCP service is not running.",
        };
        return s;
      }));
    } catch {
      update(status.services.map((s) => s.id === "updates" ? s : {
        ...s, state: "offline", detail: s.id === "server"
          ? "Cannot reach the leegen API. Retrying automatically."
          : "Cannot reach the MCP service. Retrying automatically.",
      }));
    } finally {
      checking = false;
    }
  };

  const setLive = (v: boolean) => {
    if (live === v) return;
    live = v;
    update(status.services.map((s) => s.id === "updates" ? {
      ...s, state: v ? "online" : "offline",
      detail: v ? "Live runs, edits and agent feedback are connected." : "Live updates disconnected. Reconnecting…",
    } : s));
  };

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}${api}/ws`);
    socket.onopen = () => {
      retry = 0;
      setLive(true);
      void checkHealth();
    };
    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as BackendEvent;
        listeners.forEach((l) => l(event));
      } catch {
        /* ignore */
      }
    };
    socket.onclose = () => {
      socket = null;
      setLive(false);
      void checkHealth();
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 250 * 2 ** retry);
    };
  };
  const ensure = () => {
    if (!socket) connect();
  };

  return {
    edition: "server",
    getAgentStatus: () => call<AgentStatus>("GET", `${api}/agent-status`),
    listProblems: () => call<ProblemListing>("GET", `${api}/problems`),
    getProblem: (id) => call<Problem>("GET", `${api}/problems/${enc(id)}`),
    getWorkspace: (id) => call<WorkspaceState>("GET", `${api}/workspace/${enc(id)}`),
    saveFiles: (id, files) => call("PUT", `${api}/workspace/${enc(id)}/files`, { files }),
    resetWorkspace: (id) => call("POST", `${api}/workspace/${enc(id)}/reset`),
    saveCustomTests: (id, tests: CustomTest[]) => call("PUT", `${api}/workspace/${enc(id)}/custom_tests`, { tests }),
    saveHints: (id, revealed) => call("PUT", `${api}/workspace/${enc(id)}/hints`, { revealed }),
    run: (problem_id, files, executor, run_id) =>
      call<RunResult>("POST", `${api}/run`, { problem_id, files, executor, run_id }),
    cancel: (runId) => call("POST", `${api}/run/${enc(runId)}/cancel`),
    executors: (problemId) => call<ExecutorListing>("GET", `${api}/executors?problem_id=${enc(problemId)}`),
    reportSession: (report: SessionReport) => call("POST", `${api}/session`, report),
    resolveProposal: (id, proposalId, action) =>
      call("POST", `${api}/workspace/${enc(id)}/proposals/${enc(proposalId)}/${action}`),
    deleteAnnotation: (id, annotationId) => call("DELETE", `${api}/workspace/${enc(id)}/annotations/${enc(annotationId)}`),
    assetUrl: async (problemId, src) => `${api}/problems/${enc(problemId)}/${src.replace(/^\.\//, "")}`,
    subscribe(listener) {
      ensure();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    status: {
      get: () => status,
      subscribe(listener) {
        statusListeners.add(listener);
        ensure();
        void checkHealth();
        healthTimer ??= setInterval(() => void checkHealth(), 15_000);
        return () => {
          statusListeners.delete(listener);
          if (!statusListeners.size) {
            clearInterval(healthTimer);
            healthTimer = undefined;
          }
        };
      },
    },
  };
}
