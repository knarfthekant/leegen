// Tutorials, TypeScript side: a port of the pure parts of server/src/leegen/core/tutorial.py
// (views and run inputs). `npm test` checks it against contracts/fixtures/tutorials.json.
//
// Parsing and the shim problem come from the runner (Python, `browser_runner.parse_tutorial`),
// so the schema rules live in one place.

import type { CellOutcome, Tutorial, TutorialCell, TutorialSummary } from "../../lib/api";

export type FullCheck = { description: string; code: string };

export type FullCell =
  | { type: "markdown"; text: string }
  | { type: "code"; id: string; starter: string; reference: string | null; checks: FullCheck[]; stdin: string };

/** The whole tutorial as `Tutorial.model_dump()` gives it, checks and references included. */
export interface FullTutorial {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  environment: string;
  track: string | null;
  order: number | null;
  cells: FullCell[];
}

type FullCode = Extract<FullCell, { type: "code" }>;

export const SHIM_PREFIX = "tut-";

export const cellPath = (cellId: string) => `cells/${cellId}.py`;
export const shimId = (tutorialId: string) => SHIM_PREFIX + tutorialId;
export const isShimId = (id: string) => id.startsWith(SHIM_PREFIX);

export const codeCells = (t: FullTutorial): FullCode[] =>
  t.cells.filter((c): c is FullCode => c.type === "code");

/** What a correct learner would have: each cell's reference (its starter when it has none). */
export function referenceFiles(t: FullTutorial): Record<string, string> {
  return Object.fromEntries(codeCells(t).map((c) => [cellPath(c.id), c.reference ?? c.starter]));
}

export interface RunInputs {
  code: string;
  prior: string[];
  stdin: string;
  checks: FullCheck[];
}

/** What the snippet runner needs to run `cellId` after the cells before it. */
export function cellRunInputs(t: FullTutorial, files: Record<string, string>, cellId: string): RunInputs {
  const prior: string[] = [];
  for (const c of codeCells(t)) {
    const code = files[cellPath(c.id)] ?? c.starter;
    if (c.id === cellId) {
      return { code, prior, stdin: c.stdin, checks: c.checks.map((k) => ({ description: k.description, code: k.code })) };
    }
    prior.push(code);
  }
  throw new Error(`unknown cell ${JSON.stringify(cellId)}`);
}

/** What the learner may see: no reference, no checks (only whether a cell has any). */
export function publicTutorial(t: FullTutorial): Omit<Tutorial, "files" | "results" | "annotations" | "proposals"> {
  const cells: TutorialCell[] = t.cells.map((c) =>
    c.type === "markdown"
      ? { type: "markdown", text: c.text }
      : { type: "code", id: c.id, starter: c.starter, path: cellPath(c.id), has_checks: c.checks.length > 0, stdin: c.stdin },
  );
  return { id: t.id, title: t.title, summary: t.summary, tags: t.tags, environment: t.environment, track: t.track, order: t.order, cells };
}

export function tutorialSummary(t: FullTutorial): Omit<TutorialSummary, "passed"> {
  const code = codeCells(t);
  return {
    id: t.id, title: t.title, summary: t.summary, tags: t.tags, environment: t.environment,
    track: t.track, order: t.order, cells: code.length, checked: code.filter((c) => c.checks.length > 0).length,
  };
}

// ------------------------------------------------------------------ validation and agent views

interface RunLike {
  status: string;
  error?: string | null;
  checks: { description: string; status: string; message?: string }[];
}

/** What is wrong with a cell's reference run: it must run, and pass every check. */
export function referenceIssues(cellId: string, result: RunLike): string[] {
  const issues: string[] = [];
  if (result.status !== "ok") issues.push(`cell ${cellId}: reference raised: ${(result.error ?? "").slice(-300)}`);
  for (const ck of result.checks) {
    if (ck.status !== "pass") issues.push(`cell ${cellId}: reference fails check '${ck.description}' (${ck.message || ck.status})`);
  }
  return issues;
}

/** A cell must not be passable by doing nothing: its starter has to fail a check. */
export function starterIssues(cellId: string, result: RunLike): string[] {
  return result.status === "ok" && result.checks.length > 0 && result.checks.every((c) => c.status === "pass")
    ? [`cell ${cellId}: the starter already passes every check`]
    : [];
}

/** A saved cell outcome as the agent sees it (no timestamps). */
export function outcomeBrief(o: CellOutcome | undefined | null) {
  return o
    ? { status: o.status, passed: !!o.passed,
        checks: o.checks.map((c) => ({ description: c.description ?? "", status: c.status, message: c.message ?? "" })) }
    : null;
}

/** The tutorial as the learner has it now: text, and each code cell with their code and last outcome. */
export function sessionCells(t: FullTutorial, files: Record<string, string>, results: Record<string, CellOutcome>) {
  return t.cells.map((c) => {
    if (c.type === "markdown") return { type: "markdown", text: c.text };
    const code = files[cellPath(c.id)] ?? c.starter;
    return { type: "code", id: c.id, path: cellPath(c.id), code, modified: code !== c.starter,
      has_checks: c.checks.length > 0, outcome: outcomeBrief(results[c.id]) };
  });
}

/** The list order of the server's TutorialStore: track, order, title. */
export function compareTutorials(a: Pick<TutorialSummary, "track" | "order" | "title">, b: typeof a): number {
  const ka = [a.track ?? "~", a.order ?? 9999, a.title.toLowerCase()] as const;
  const kb = [b.track ?? "~", b.order ?? 9999, b.title.toLowerCase()] as const;
  for (let i = 0; i < 3; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}
