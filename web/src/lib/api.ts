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

// Records shared with the server come from the generated contracts (uv run leetclaude schema).
export type { Annotation, Metric, Proposal, RunResult, TestResult } from "../contracts/generated";
import type { Annotation, Proposal, RunResult } from "../contracts/generated";

export type Severity = Annotation["severity"];

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
  runtime?: string;
  description: string;
  compatible: boolean;
  device: string;
}

export function newRunId(): string {
  return Math.random().toString(16).slice(2, 14);
}
