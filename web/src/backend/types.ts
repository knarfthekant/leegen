// The seam between the UI and wherever problems live and code runs.
//
// - ServerBackend (./server.ts): the local leetclaude server over REST + WebSocket.
// - BrowserBackend (./browser/): IndexedDB + a separate-origin Pyodide runner + WebMCP tools.
//
// Components only talk to `getBackend()` (./index.ts); nothing else knows which edition runs.

import type { BackendEvent } from "../contracts/generated";
import type {
  CustomTest,
  ExecutorInfo,
  Problem,
  ProblemSummary,
  RunResult,
  WorkspaceState,
} from "../lib/api";

export type { BackendEvent };

export interface ProblemListing {
  problems: ProblemSummary[];
  errors: { path: string; error: string }[];
}

export interface ExecutorListing {
  executors: ExecutorInfo[];
  requires: string[];
  /** Runtimes the problem's environment supports: "native" (venv) and/or "pyodide" (browser). */
  runtimes?: string[];
}

/** What the editor reports so agents (get_session) see the user's live state. */
export interface SessionReport {
  problem_id: string;
  buffers: Record<string, string>;
  active_file: string;
  cursor: { line: number; column: number } | null;
  selection: { start_line: number; end_line: number; text: string } | null;
  executor: string | null;
}

export interface BackendStatus {
  /** Shown as the topbar pill. */
  ok: boolean;
  label: string;
  title: string;
}

export interface Backend {
  readonly edition: "server" | "browser";

  listProblems(): Promise<ProblemListing>;
  getProblem(id: string): Promise<Problem>;
  getWorkspace(id: string): Promise<WorkspaceState>;
  saveFiles(id: string, files: Record<string, string>): Promise<{ written: string[] }>;
  resetWorkspace(id: string): Promise<{ files: Record<string, string> }>;
  saveCustomTests(id: string, tests: CustomTest[]): Promise<unknown>;
  saveHints(id: string, revealed: number): Promise<unknown>;

  /** Saves `files` too: a run always reflects (and persists) what the user sees. */
  run(problemId: string, files: Record<string, string>, executor: string | null, runId: string): Promise<RunResult>;
  cancel(runId: string): Promise<unknown>;
  executors(problemId: string): Promise<ExecutorListing>;

  reportSession(report: SessionReport): Promise<unknown>;
  resolveProposal(id: string, proposalId: string, action: "accept" | "reject"): Promise<{ files: Record<string, string> }>;
  deleteAnnotation(id: string, annotationId: string): Promise<unknown>;

  /** URL for an image referenced from a problem's Markdown (`assets/x.png`), or undefined. */
  assetUrl(problemId: string, src: string): Promise<string | undefined>;

  /** Push events: runs, file changes, annotations, proposals, navigation. */
  subscribe(listener: (e: BackendEvent) => void): () => void;
  status: {
    get(): BackendStatus;
    subscribe(listener: () => void): () => void;
  };
}
