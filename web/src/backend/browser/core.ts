// TypeScript port of leetclaude.core.views and leetclaude.core.review: the parts of the core the
// browser edition needs without waiting for Pyodide (listing, tutoring tools, the review flow).
// Run planning, result assembly and validation are NOT ported; the runner runs the real Python.
//
// Checked against contracts/fixtures/{views,review}.json (core.test.ts), so error messages and
// shapes match the server exactly. Pure: no DOM, no storage; ids and clocks are injected.
// Import with explicit .ts extensions so `node --test` can load it directly.

import type { Environment, Problem as FullProblem, ProblemFile, TestInput } from "../../contracts/generated";

export type { Environment, FullProblem };
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Dict = Record<string, unknown>;

export const FROM_REFERENCE = "from_reference";
export const SEVERITIES = ["info", "hint", "warning", "error", "praise"] as const;

/** Raised for bad arguments (the server's ValueError, REST 400). */
export class InvalidError extends Error {
  name = "InvalidError";
}

/** Raised for unknown ids (the server's LookupError, REST 404). */
export class NotFoundError extends Error {
  name = "NotFoundError";
}

// ------------------------------------------------------------------ python-compatible repr

/** Python's repr() for the values that appear in error messages. */
export function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    const quote = v.includes("'") && !v.includes('"') ? '"' : "'";
    const body = v
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\t/g, "\\t")
      .replace(/\r/g, "\\r");
    return quote + (quote === "'" ? body.replace(/'/g, "\\'") : body) + quote;
  }
  if (Array.isArray(v)) return `[${v.map(pyRepr).join(", ")}]`;
  return String(v);
}

const pyTuple = (items: readonly unknown[]) => `(${items.map(pyRepr).join(", ")})`;

// ------------------------------------------------------------------ problem helpers (models.py)

const files = (p: FullProblem): Required<ProblemFile>[] =>
  p.files.map((f) => ({ path: f.path, role: f.role ?? "editable", content: f.content ?? "", language: f.language ?? null }));

export function problemFile(p: FullProblem, path: string) {
  return files(p).find((f) => f.path === path) ?? null;
}

export function editableFiles(p: FullProblem) {
  return files(p).filter((f) => f.role === "editable");
}

export function pytestFiles(p: FullProblem): string[] {
  if (p.judge.test_files?.length) return [...p.judge.test_files];
  return files(p)
    .filter((f) => (f.path.split("/").pop() ?? "").startsWith("test_") && f.path.endsWith(".py"))
    .map((f) => f.path);
}

const needsReference = (t: { expected?: unknown }) => t.expected === FROM_REFERENCE;

// ------------------------------------------------------------------ views.py

export function problemSummary(p: FullProblem) {
  return {
    id: p.id,
    title: p.title,
    difficulty: p.difficulty ?? "medium",
    tags: p.tags ?? [],
    track: p.track ?? null,
    order: p.order ?? null,
    environment: p.environment,
    requires: p.requires ?? ["cpu"],
    judge: p.judge.kind,
  };
}

export type ProblemSummary = ReturnType<typeof problemSummary>;

export function runStatus(lastRun: { status?: string } | null | undefined): "passed" | "attempted" | null {
  if (!lastRun) return null;
  return lastRun.status === "passed" ? "passed" : "attempted";
}

/** Sort like the server: (track or "~", order or 0, lowercased title). */
export function compareSummaries(a: ProblemSummary, b: ProblemSummary): number {
  const ka = [a.track || "~", a.order || 0, a.title.toLowerCase()] as const;
  const kb = [b.track || "~", b.order || 0, b.title.toLowerCase()] as const;
  for (let i = 0; i < 3; i++) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

/** TestInput.model_dump(exclude_defaults=True). */
function inputWithoutDefaults(input: TestInput): Dict {
  const out: Dict = {};
  if (input.args && input.args.length) out.args = input.args;
  if (input.kwargs && Object.keys(input.kwargs).length) out.kwargs = input.kwargs;
  if (input.gen != null) out.gen = input.gen;
  if (input.seed != null && input.seed !== 0) out.seed = input.seed;
  if (input.calls != null) {
    out.calls = input.calls.map((c) => {
      const call: Dict = { method: c.method };
      if (c.args && c.args.length) call.args = c.args;
      if (c.kwargs && Object.keys(c.kwargs).length) call.kwargs = c.kwargs;
      return call;
    });
  }
  return out;
}

/** The problem without hidden files, the reference, or hidden test data. */
export function publicProblem(p: FullProblem) {
  const tests = (p.tests ?? []).map((t) => {
    const visible = t.visible ?? true;
    const item: Dict = { name: t.name, visible, description: t.description ?? null, section: t.section ?? null };
    if (visible) {
      item.input = t.input ? inputWithoutDefaults(t.input) : null;
      item.expected = needsReference(t) ? null : (t.expected ?? null);
    }
    return item;
  });
  const compare = p.judge.compare ?? {};
  return {
    ...problemSummary(p),
    description: p.description,
    hints: p.hints ?? [],
    files: files(p).filter((f) => f.role !== "hidden"),
    judge: {
      kind: p.judge.kind,
      entry: p.judge.entry ?? null,
      params: p.judge.params ?? null,
      compare: compare.kind ?? "exact",
    },
    sections: (p.sections ?? []).map((s) => ({ id: s.id, title: s.title, description: s.description ?? null })),
    tests,
    has_reference: p.reference != null,
    limits: { timeout_s: p.limits?.timeout_s ?? 10, memory_mb: p.limits?.memory_mb ?? null },
    benchmark: p.benchmark
      ? { against: p.benchmark.against ?? "reference", repeats: p.benchmark.repeats ?? 20, max_slowdown: p.benchmark.max_slowdown ?? null }
      : null,
  };
}

export const BRIEF_TEST_KEYS = ["name", "section", "description", "status", "visible", "input", "expected", "actual", "message", "stdout"] as const;

/** A run as the tutoring agent sees it: failing tests only, unless `full`. */
export function briefRun(result: Dict | null | undefined, full = false): Dict | null {
  if (!result) return null;
  const tests = (result.tests as Dict[] | undefined) ?? [];
  const shown = full ? tests : tests.filter((t) => t.status !== "pass");
  const get = (k: string) => (result[k] === undefined ? null : result[k]);
  return {
    status: get("status"),
    passed: get("passed"),
    total: get("total"),
    executor: get("executor"),
    device: get("device"),
    error: get("error"),
    compile_output: get("compile_output"),
    metrics: get("metrics"),
    [full ? "tests" : "failing_tests"]: shown.map((t) =>
      Object.fromEntries(BRIEF_TEST_KEYS.filter((k) => t[k] !== undefined && t[k] !== null).map((k) => [k, t[k]])),
    ),
  };
}

// ------------------------------------------------------------------ plan.py

export function uniqueTestName(wanted: string | null | undefined, taken: Set<string>): string {
  const w = (wanted ?? "").trim();
  if (w && !taken.has(w)) return w;
  const base = w || "Test";
  for (let n = 1; ; n++) {
    const name = w ? `${w} (${n + 1})` : `${base} ${n}`;
    if (!taken.has(name)) return name;
  }
}

// ------------------------------------------------------------------ review.py

export interface Clock {
  now: () => number;
  newId: () => string;
}

export const defaultClock: Clock = {
  now: () => Date.now() / 1000,
  newId: () => Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, "0")).join(""),
};

const pyLen = (s: string) => Array.from(s).length;   // code points, like Python's len()
const lstrip = (s: string) => s.replace(/^\s+/, "");
const rstrip = (s: string) => s.replace(/\s+$/, "");

export function resolveColumns(
  startCol: number | null | undefined,
  endCol: number | null | undefined,
  start: number,
  end: number,
  lines: string[],
  file: string,
): [number, number] {
  const first = lines[start - 1];
  const last = lines[end - 1];
  if (startCol == null) {
    if (endCol != null) throw new InvalidError("end_col needs start_col");
    const s = pyLen(first) - pyLen(lstrip(first)) + 1;
    let e = pyLen(rstrip(last)) + 1;
    if (start === end && e < s) e = s;
    return [s, e];
  }
  if (endCol == null) endCol = Math.max(pyLen(rstrip(last)) + 1, start === end ? startCol : 1);
  if (!(startCol >= 1 && startCol <= pyLen(first) + 1)) {
    throw new InvalidError(`start_col ${startCol} is outside line ${start} of ${file} (1-${pyLen(first) + 1})`);
  }
  if (!(endCol >= 1 && endCol <= pyLen(last) + 1)) {
    throw new InvalidError(`end_col ${endCol} is outside line ${end} of ${file} (1-${pyLen(last) + 1})`);
  }
  if (start === end && endCol <= startCol) {
    throw new InvalidError("end_col must be greater than start_col on a single line (end_col is exclusive)");
  }
  return [startCol, endCol];
}

export interface AnnotationRequest {
  file?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  start_col?: number | null;
  end_col?: number | null;
  severity?: string;
  message?: string;
  author?: string | null;
}

export interface AnnotationRecord {
  id: string;
  file: string | null;
  start_line: number | null;
  end_line: number | null;
  start_col: number | null;
  end_col: number | null;
  severity: (typeof SEVERITIES)[number];
  message: string;
  author: string;
  created_at: number;
}

export function makeAnnotations(
  problem: FullProblem,
  current: Record<string, string>,
  items: AnnotationRequest[],
  author = "assistant",
  clock: Clock = defaultClock,
): AnnotationRecord[] {
  const visible = new Set(files(problem).filter((f) => f.role !== "hidden").map((f) => f.path));
  const created: AnnotationRecord[] = [];
  for (const item of items) {
    const file = item.file ?? null;
    const severity = item.severity ?? "info";
    if (!(SEVERITIES as readonly string[]).includes(severity)) {
      throw new InvalidError(`severity must be one of ${pyTuple(SEVERITIES)}`);
    }
    if (!item.message) throw new InvalidError("each annotation needs a message");
    const start = item.start_line ?? null;
    const end = item.end_line || start;
    let startCol: number | null = null;
    let endCol: number | null = null;
    if (file !== null) {
      if (!visible.has(file)) throw new InvalidError(`${pyRepr(file)} is not a visible file of ${problem.id}`);
      const pf = problemFile(problem, file);
      const content = current[file] || (pf ? pf.content : "");
      const nLines = Math.max(1, content.split("\n").length);
      if (start === null) throw new InvalidError("annotations on a file need start_line (1-based)");
      if (!(start >= 1 && start <= nLines) || !(end !== null && start <= end && end <= nLines)) {
        throw new InvalidError(`line range ${start}-${end} is outside ${file} (1-${nLines})`);
      }
      [startCol, endCol] = resolveColumns(item.start_col, item.end_col, start, end, content.split("\n"), file);
    }
    created.push({
      id: clock.newId(),
      file,
      start_line: start,
      end_line: file ? end : null,
      start_col: startCol,
      end_col: endCol,
      severity: severity as AnnotationRecord["severity"],
      message: item.message,
      author: item.author || author,
      created_at: clock.now(),
    });
  }
  return created;
}

export function withoutAnnotations<T extends { id: string; file?: string | null }>(
  items: T[],
  opts: { annotation_id?: string | null; file?: string | null; clear?: boolean },
): T[] {
  if (opts.clear) return items.filter((a) => opts.file != null && a.file !== opts.file);
  return items.filter((a) => a.id !== opts.annotation_id);
}

const countOccurrences = (s: string, sub: string) => (sub ? s.split(sub).length - 1 : 0);

export function applyEdits(content: string, edits: { old?: string; new?: string }[]): string {
  edits.forEach((e, i) => {
    const old = e.old ?? "";
    const count = countOccurrences(content, old);
    if (count !== 1) throw new InvalidError(`edit ${i + 1}: \`old\` text must match exactly once (found ${count})`);
    const at = content.indexOf(old);
    content = content.slice(0, at) + (e.new ?? "") + content.slice(at + old.length);
  });
  return content;
}

export interface ProposalRecord {
  id: string;
  file: string;
  content: string;
  rationale: string;
  author: string;
  source: "mcp" | "disk" | "webmcp";
  created_at: number;
}

export function makeProposal(
  problem: FullProblem,
  current: Record<string, string>,
  file: string,
  opts: {
    content?: string | null;
    edits?: { old?: string; new?: string }[] | null;
    rationale?: string;
    author?: string;
    source?: ProposalRecord["source"];
  },
  clock: Clock = defaultClock,
): ProposalRecord {
  const f = problemFile(problem, file);
  if (!f || f.role !== "editable") throw new InvalidError(`${pyRepr(file)} is not an editable file of ${problem.id}`);
  const base = current[file];
  let content = opts.content ?? null;
  if (content === null) {
    if (!opts.edits || !opts.edits.length) throw new InvalidError("give either `content` (the full new file) or `edits`");
    content = applyEdits(base, opts.edits);
  }
  if (content === base) throw new InvalidError("the proposed content is identical to the current code");
  return {
    id: clock.newId(),
    file,
    content,
    rationale: opts.rationale ?? "",
    author: opts.author ?? "assistant",
    source: opts.source ?? "mcp",
    created_at: clock.now(),
  };
}

/** One pending proposal per file: a newer one replaces the older one. */
export function withProposal<T extends { file: string }>(items: T[], proposal: T): T[] {
  return [...items.filter((p) => p.file !== proposal.file), proposal];
}

export interface CustomTestRecord {
  input: { args: unknown[]; kwargs: Record<string, unknown> } | Dict;
  name?: string;
  description?: string;
  section?: string;
  expected?: unknown;
}

export function makeCustomTest(
  problem: FullProblem,
  existing: CustomTestRecord[],
  args: unknown,
  kwargs?: Record<string, unknown> | null,
  name?: string | null,
  description?: string | null,
  section?: string | null,
): CustomTestRecord {
  if (problem.judge.kind !== "function") {
    throw new InvalidError("custom test cases are only supported for function-judge problems");
  }
  if (!problem.reference) throw new InvalidError("this problem has no reference solution to compute expected output");
  if (!Array.isArray(args)) throw new InvalidError("args must be a list of positional arguments");
  const sectionIds = (problem.sections ?? []).map((s) => s.id);
  if (section != null && !sectionIds.includes(section)) {
    throw new InvalidError(`unknown section ${pyRepr(section)}; sections: ${pyRepr(sectionIds)}`);
  }
  const taken = new Set<string>([
    ...(problem.tests ?? []).map((t) => t.name),
    ...existing.map((t) => t.name).filter((n): n is string => !!n),
  ]);
  const test: CustomTestRecord = { input: { args, kwargs: kwargs ?? {} }, name: uniqueTestName(name, taken) };
  if (description) test.description = description;
  if (section) test.section = section;
  return test;
}

// ------------------------------------------------------------------ compat.py

export function satisfies(capabilities: Iterable<string>, requires: Iterable<string>): boolean {
  const caps = new Set(capabilities);
  for (const r of requires) {
    if (r === "cpu" && !caps.has("cpu")) return false;
    if (r === "gpu" && !["cuda", "mps", "gpu"].some((c) => caps.has(c))) return false;
    if (r === "cuda" && !caps.has("cuda")) return false;
    if (r === "webgpu" && !caps.has("webgpu")) return false;
  }
  return true;
}

export function requirements(problem: FullProblem, env: Environment | null | undefined): string[] {
  return [...new Set([...(problem.requires ?? ["cpu"]), ...(env?.requires ?? ["cpu"])])].sort();
}

export function runtimes(env: Environment | null | undefined): Set<string> {
  if (!env) return new Set(["native"]);
  const out = new Set<string>();
  if (env.native ?? true) out.add("native");
  if (env.browser) out.add("pyodide");
  return out;
}

export function canRun(caps: Iterable<string>, runtime: string, requires: Iterable<string>, env: Environment | null | undefined) {
  return runtimes(env).has(runtime) && satisfies(caps, requires);
}

export function deviceFor(caps: Iterable<string>, requires: Iterable<string>): string {
  const c = new Set(caps);
  const r = new Set(requires);
  if (r.has("webgpu")) return "webgpu";
  if (!r.has("gpu") && !r.has("cuda")) return "cpu";
  if (c.has("cuda")) return "cuda";
  if (c.has("mps")) return "mps";
  return "cpu";
}
