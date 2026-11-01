export type Difficulty = "intro" | "easy" | "medium" | "hard";
export type TestStatus = "pass" | "fail" | "error" | "timeout" | "skipped";
export type RunStatus = "passed" | "failed" | "error" | "timeout" | "compile_error" | "cancelled";

export interface ProblemSummary {
  id: string;
  title: string;
  difficulty: Difficulty;
  tags: string[];
  track: string | null;
  order: number | null;
  environment: string;
  requires: string[];
  judge: string;
  status?: "passed" | "attempted" | null;
}

export interface ProblemFile {
  path: string;
  role: "editable" | "readonly";
  content: string;
  language: string | null;
}

export interface TestInput {
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  gen?: string;
  seed?: number;
  calls?: { method: string; args?: unknown[]; kwargs?: Record<string, unknown> }[];
}

export interface PublicSection {
  id: string;
  title: string;
  description: string | null;
}

export interface PublicTest {
  name: string;
  visible: boolean;
  description: string | null;
  section?: string | null;
  input?: TestInput | null;
  expected?: unknown;
}

export interface Problem extends Omit<ProblemSummary, "judge" | "status"> {
  description: string;
  hints: string[];
  files: ProblemFile[];
  judge: { kind: string; entry: string | null; params: string[] | null; compare: string };
  sections: PublicSection[];
  tests: PublicTest[];
  has_reference: boolean;
  limits: { timeout_s: number; memory_mb: number | null };
}

export interface TestResult {
  name: string;
  status: TestStatus;
  visible: boolean;
  custom: boolean;
  input: unknown;
  expected: unknown;
  actual: unknown;
  message: string | null;
  stdout: string | null;
  duration_ms: number | null;
  description?: string | null;
  section?: string | null;
}

export interface RunResult {
  run_id: string;
  problem_id: string;
  status: RunStatus;
  executor: string;
  device: string | null;
  started_at: number;
  duration_ms: number;
  passed: number;
  total: number;
  tests: TestResult[];
  metrics: { name: string; value: number; unit: string; reference: number | null }[];
  compile_output: string | null;
  error: string | null;
  stdout: string;
  stderr: string;
}

export type Severity = "info" | "hint" | "warning" | "error" | "praise";

export interface Annotation {
  id: string;
  file: string | null; // null = general comment
  start_line: number | null;
  end_line: number | null;
  /** 1-based; with end_col the annotation marks exact characters. end_col is exclusive. */
  start_col?: number | null;
  end_col?: number | null;
  severity: Severity;
  message: string;
  author: string;
  created_at: number;
}

export interface Proposal {
  id: string;
  file: string;
  content: string;
  rationale: string;
  author: string;
  source: "mcp" | "disk";
  created_at: number;
}

export interface CustomTest {
  name?: string;
  description?: string;
  section?: string;
  input: TestInput;
}

export interface WorkspaceState {
  files: Record<string, string>;
  custom_tests: CustomTest[];
  last_run: RunResult | null;
  annotations: Annotation[];
  proposals: Proposal[];
  hints_revealed: number;
}

export interface ExecutorInfo {
  id: string;
  kind: string;
  capabilities: string[];
  description: string;
  compatible: boolean;
  device: string;
}

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

export const api = {
  problems: () =>
    call<{ problems: ProblemSummary[]; errors: { path: string; error: string }[] }>(
      "GET",
      "/api/problems",
    ),
  problem: (id: string) => call<Problem>("GET", `/api/problems/${enc(id)}`),
  workspace: (id: string) => call<WorkspaceState>("GET", `/api/workspace/${enc(id)}`),
  saveFiles: (id: string, files: Record<string, string>) =>
    call<{ written: string[] }>("PUT", `/api/workspace/${enc(id)}/files`, { files }),
  reset: (id: string) =>
    call<{ files: Record<string, string> }>("POST", `/api/workspace/${enc(id)}/reset`),
  saveCustomTests: (id: string, tests: CustomTest[]) =>
    call("PUT", `/api/workspace/${enc(id)}/custom_tests`, { tests }),
  saveHints: (id: string, revealed: number) =>
    call("PUT", `/api/workspace/${enc(id)}/hints`, { revealed }),
  run: (problem_id: string, files: Record<string, string>, executor: string | null, run_id: string) =>
    call<RunResult>("POST", "/api/run", { problem_id, files, executor, run_id }),
  cancel: (run_id: string) => call("POST", `/api/run/${enc(run_id)}/cancel`),
  executors: (problem_id: string) =>
    call<{ executors: ExecutorInfo[]; requires: string[] }>(
      "GET",
      `/api/executors?problem_id=${enc(problem_id)}`,
    ),
  session: (body: Record<string, unknown>) => call("POST", "/api/session", body),
  resolveProposal: (id: string, proposalId: string, action: "accept" | "reject") =>
    call<{ files: Record<string, string> }>(
      "POST",
      `/api/workspace/${enc(id)}/proposals/${enc(proposalId)}/${action}`,
    ),
  deleteAnnotation: (id: string, annotationId: string) =>
    call("DELETE", `/api/workspace/${enc(id)}/annotations/${enc(annotationId)}`),
};

export function newRunId(): string {
  return Math.random().toString(16).slice(2, 14);
}
