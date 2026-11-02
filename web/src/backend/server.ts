// The server edition: REST under /api and a listen-only WebSocket at /api/ws.

import type { CustomTest, Problem, RunResult, WorkspaceState } from "../lib/api";
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
  let live = false;
  let status: BackendStatus = { ok: false, label: "Offline", title: "Reconnecting…" };

  const setLive = (v: boolean) => {
    if (live === v) return;
    live = v;
    status = v
      ? { ok: true, label: "Live", title: "Connected to the leetclaude server" }
      : { ok: false, label: "Offline", title: "Reconnecting…" };
    statusListeners.forEach((l) => l());
  };

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    socket = new WebSocket(`${proto}://${location.host}${api}/ws`);
    socket.onopen = () => {
      retry = 0;
      setLive(true);
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
      retry = Math.min(retry + 1, 6);
      setTimeout(connect, 250 * 2 ** retry);
    };
  };
  const ensure = () => {
    if (!socket) connect();
  };

  return {
    edition: "server",
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
        ensure();
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
    },
  };
}
