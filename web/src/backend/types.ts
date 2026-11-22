// The seam between the UI and wherever problems live and code runs.
//
// - ServerBackend (./server.ts): the local leegen server over REST + WebSocket.
// - BrowserBackend (./browser/): IndexedDB + a separate-origin Pyodide runner + WebMCP tools.
//   The browser store is its only storage; a zip export/import is the only way data moves.
//
// Components only talk to `getBackend()` (./index.ts); nothing else knows which edition runs.

import type { AgentStatus, BackendEvent, ConsoleResult } from "../contracts/generated";
import type {
  CustomTest,
  Tutorial,
  TutorialSummary,
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
  /** Whether the quick-execution console can run this problem's language. */
  console?: boolean;
}

/** One quick-execution snippet: code plus the file whose namespace it runs inside. */
export interface ConsoleRequest {
  files: Record<string, string>;
  code: string;
  file: string | null;
  stdin: string;
  executor: string | null;
  runId: string;
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

export interface ServiceStatus {
  id: string;
  label: string;
  state: "online" | "offline" | "connecting" | "unavailable" | "degraded";
  detail: string;
}

export interface BackendStatus {
  /** Ordered services shown in the topbar and its expanded status panel. */
  services: ServiceStatus[];
}

export interface ImportSummary {
  problems: string[];
  tutorials: string[];
  unchanged: string[];
  workspaces: string[];
  errors: { path: string; error: string }[];
}

/** Tutorials: notebook-like pages of Markdown and code cells, in both editions. */
export interface TutorialApi {
  list(): Promise<{ tutorials: TutorialSummary[]; errors: { path: string; error: string }[] }>;
  get(id: string): Promise<Tutorial>;
  saveFiles(id: string, files: Record<string, string>): Promise<unknown>;
  /** Replay the learner's earlier cells, run this one, then its hidden checks. */
  runCell(id: string, cell: string, files: Record<string, string>, runId: string): Promise<ConsoleResult>;
  cancel(runId: string): Promise<unknown>;
  /** One cell back to its starter, or (no cell) the whole tutorial. */
  reset(id: string, cell?: string): Promise<{ files: Record<string, string>; results: Tutorial["results"] }>;
}

export interface Backend {
  readonly edition: "server" | "browser";
  readonly tutorials?: TutorialApi;

  getAgentStatus(): Promise<AgentStatus>;

  listProblems(): Promise<ProblemListing>;
  getProblem(id: string): Promise<Problem>;
  getWorkspace(id: string): Promise<WorkspaceState>;
  saveFiles(id: string, files: Record<string, string>): Promise<{ written: string[] }>;
  resetWorkspace(id: string): Promise<{ files: Record<string, string> }>;
  saveCustomTests(id: string, tests: CustomTest[]): Promise<unknown>;
  saveHints(id: string, revealed: number): Promise<unknown>;

  /** Saves `files` too: a run always reflects (and persists) what the user sees. */
  run(problemId: string, files: Record<string, string>, executor: string | null, runId: string): Promise<RunResult>;
  /** Runs one console snippet. Uses the live buffers but never saves them or `last_run`. */
  runConsole(problemId: string, request: ConsoleRequest): Promise<ConsoleResult>;
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

  /** Browser edition: move problems, tutorials and work to and from a data-layout zip. */
  transfer?: {
    exportZip(): Promise<Blob>;
    importZip(file: Blob): Promise<ImportSummary>;
  };
}
