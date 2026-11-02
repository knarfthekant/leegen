// BrowserToolService: the browser edition's counterpart of the server's ToolService
// (server/src/leegen/service.py). Same operations, same result shapes and error messages,
// so the WebMCP tools (tools.ts) and the UI backend (index.ts) behave like MCP and REST do.
//
// Storage is IndexedDB (db.ts), events go through the EventHub (this tab + BroadcastChannel),
// and runs, validation and YAML parsing go to the separate-origin runner (runner.ts), which runs
// the real Python core in Pyodide.

import type { BackendEvent } from "../types";
import type { AgentStatus, RunResult } from "../../contracts/generated";
import {
  type AnnotationRecord,
  type AnnotationRequest,
  type Clock,
  type CustomTestRecord,
  type Environment,
  type FullProblem,
  type ProposalRecord,
  InvalidError,
  NotFoundError,
  briefRun,
  canRun,
  compareSummaries,
  defaultClock,
  deviceFor,
  editableFiles,
  makeAnnotations,
  makeCustomTest,
  makeProposal,
  problemSummary,
  publicProblem,
  pyRepr,
  requirements,
  runStatus,
  runtimes,
  withProposal,
  withoutAnnotations,
} from "./core.ts";
import type { Db, ProblemRecord, WorkspaceRecord } from "./db.ts";
import type { EventHub } from "./events.ts";
import type { RunnerClient } from "./runner.ts";

export const EXECUTOR_ID = "browser";

export interface Guides {
  authoring: string;
  tutoring: string;
  browser: string;
}

export interface Session {
  problem_id: string | null;
  buffers: Record<string, string>;
  active_file: string | null;
  cursor: { line: number; column: number } | null;
  selection: { start_line: number; end_line: number; text: string } | null;
  executor: string | null;
  updated_at: number;
}

type Dict = Record<string, unknown>;
type Source = ProposalRecord["source"];

export interface ServiceDeps {
  db: Db;
  hub: EventHub;
  runner: RunnerClient;
  environments: Environment[];
  guides: Guides;
  schema: unknown;
  clock?: Clock;
  /** Static URL prefix of bundled seed assets (data/assets/). */
  seedAssets?: string;
}

export class BrowserToolService {
  readonly session: Session = {
    problem_id: null,
    buffers: {},
    active_file: null,
    cursor: null,
    selection: null,
    executor: null,
    updated_at: 0,
  };
  private db: Db;
  private hub: EventHub;
  readonly runner: RunnerClient;
  private envs: Map<string, Environment>;
  private guides: Guides;
  private schema: unknown;
  private clock: Clock;
  private localLocks = new Map<string, Promise<unknown>>();
  private persistAsked = false;

  constructor(deps: ServiceDeps) {
    this.db = deps.db;
    this.hub = deps.hub;
    this.runner = deps.runner;
    this.envs = new Map(deps.environments.map((e) => [e.id, e]));
    this.guides = deps.guides;
    this.schema = deps.schema;
    this.clock = deps.clock ?? defaultClock;
  }

  private broadcast(e: BackendEvent) {
    this.hub.broadcast(e);
  }

  // ---------------------------------------------------------------- lookups

  async record(problemId?: string | null): Promise<ProblemRecord> {
    const pid = problemId || this.session.problem_id;
    if (!pid) throw new InvalidError("no problem_id given and the user has no problem open");
    const rec = await this.db.get<ProblemRecord>("problems", pid);
    if (!rec) throw new NotFoundError(`no problem ${pyRepr(pid)}; call list_problems`);
    return rec;
  }

  async problem(problemId?: string | null): Promise<FullProblem> {
    return (await this.record(problemId)).problem;
  }

  private async ws(id: string): Promise<WorkspaceRecord> {
    return (await this.db.get<WorkspaceRecord>("workspace", id)) ?? { id, files: {}, state: {} };
  }

  private async state<T>(id: string, name: string, fallback: T): Promise<T> {
    const v = (await this.ws(id)).state[name];
    return v === undefined ? fallback : (v as T);
  }

  private async writeState(id: string, name: string, value: unknown) {
    await this.db.update<WorkspaceRecord>("workspace", id, (old) => {
      const w = old ?? { id, files: {}, state: {} };
      return { ...w, state: { ...w.state, [name]: value } };
    });
  }

  /** The user's saved editable files (starter code where nothing is saved yet). */
  async workspaceFiles(p: FullProblem): Promise<Record<string, string>> {
    const saved = (await this.ws(p.id)).files;
    return Object.fromEntries(editableFiles(p).map((f) => [f.path, saved[f.path] ?? f.content]));
  }

  /** The user's code as they see it: unsaved editor buffers win over storage. */
  async currentFiles(p: FullProblem): Promise<Record<string, string>> {
    const files = await this.workspaceFiles(p);
    if (this.session.problem_id === p.id) {
      for (const [path, content] of Object.entries(this.session.buffers)) {
        if (path in files) files[path] = content;
      }
    }
    return files;
  }

  environment(p: FullProblem): Environment | null {
    return this.envs.get(p.environment) ?? null;
  }

  /** What this browser offers: always cpu, plus webgpu when the runner has an adapter. */
  async capabilities(): Promise<string[]> {
    try {
      await this.runner.connect();
      await waitFor(() => this.runner.state !== "connecting");
    } catch {
      /* runner unavailable: cpu only, runs will report the error */
    }
    return this.runner.hello?.webgpu ? ["cpu", "webgpu"] : ["cpu"];
  }

  // ---------------------------------------------------------------- authoring

  async getAgentStatus(): Promise<AgentStatus> {
    const status = await this.db.get<AgentStatus>("meta", "agent_status");
    if (!status || (status.expires_at !== null && status.expires_at <= this.clock.now())) {
      return { status: "idle", updated_at: status?.updated_at ?? 0, expires_at: null };
    }
    return status;
  }

  async setAgentStatus(status: AgentStatus["status"]): Promise<AgentStatus> {
    if (!["idle", "reviewing", "creating_problem"].includes(status)) {
      throw new InvalidError("status must be one of idle, reviewing, creating_problem");
    }
    const now = this.clock.now();
    const result: AgentStatus = { status, updated_at: now, expires_at: status === "idle" ? null : now + 300 };
    await this.db.put("meta", result, "agent_status");
    this.broadcast({ type: "agent_status_changed", agent_status: result });
    return result;
  }

  authoringGuide(): string {
    const browser = this.guides.browser ? `\n\n---\n\n${this.guides.browser}` : "";
    return (this.guides.authoring || "docs/authoring.md is missing") + browser;
  }

  tutoringGuide(): string {
    return this.guides.tutoring;
  }

  problemSchema(): unknown {
    return this.schema;
  }

  async listEnvironments(): Promise<Dict> {
    const caps = await this.capabilities();
    return {
      environments: [...this.envs.values()].map((env) => ({
        ...env,
        executors: canRun(caps, "pyodide", [...(env.requires ?? ["cpu"])].sort(), env) ? [EXECUTOR_ID] : [],
      })),
    };
  }

  environmentList(): Dict {
    return { environments: [...this.envs.values()] };
  }

  private describeExecutor(caps: string[]) {
    return {
      id: EXECUTOR_ID,
      kind: "pyodide",
      capabilities: [...caps].sort(),
      runtime: "pyodide",
      description: "Python in this browser (Pyodide in a separate-origin runner)",
    };
  }

  async listExecutors(): Promise<Dict> {
    return { executors: [this.describeExecutor(await this.capabilities())] };
  }

  async listProblems(track?: string | null): Promise<Dict> {
    const recs = await this.db.all<ProblemRecord>("problems");
    const items = recs.map((r) => problemSummary(r.problem)).filter((s) => !track || s.track === track);
    items.sort(compareSummaries);
    return { problems: items, invalid_files: [] };
  }

  async problemListView() {
    const [recs, wss] = await Promise.all([
      this.db.all<ProblemRecord>("problems"),
      this.db.all<WorkspaceRecord>("workspace"),
    ]);
    const lastRun = new Map(wss.map((w) => [w.id, w.state.last_run as { status?: string } | undefined]));
    const items = recs.map((r) => ({
      ...problemSummary(r.problem),
      status: runStatus(lastRun.get(r.id)),
      runtimes: [...runtimes(this.environment(r.problem))].sort(),
    }));
    items.sort(compareSummaries);
    return { problems: items, errors: [] as { path: string; error: string }[] };
  }

  async getProblem(problemId: string, includeHidden = true): Promise<Dict> {
    const rec = await this.record(problemId);
    if (includeHidden) return { id: rec.id, yaml: rec.yaml };
    return publicProblem(rec.problem);
  }

  /** Schema check, then the reference-passes / starter-fails runs, in the runner. */
  async validateYaml(yaml: string): Promise<{ problem: FullProblem | null; report: Dict }> {
    if (typeof yaml !== "string" || !yaml.trim()) throw new InvalidError("yaml must be the problem YAML text");
    const parsed = await this.runner.parse(yaml);
    if (!parsed.ok || !parsed.problem) {
      return { problem: null, report: { ok: false, stage: "schema", errors: parsed.errors ?? "invalid problem" } };
    }
    const problem = parsed.problem;
    const env = this.environment(problem);
    const report = await this.runner.validate({
      problem_yaml: yaml,
      environments: [...this.envs.values()],
      capabilities: await this.capabilities(),
      packages: env?.browser?.packages ?? [],
    });
    return { problem, report: { stage: "run", ...report } };
  }

  async createProblem(yaml: string, overwrite = false): Promise<Dict> {
    const { problem, report } = await this.validateYaml(yaml);
    if (!problem) return { saved: false, ...report };
    if ((await this.db.get("problems", problem.id)) && !overwrite) {
      return { saved: false, ok: false, errors: `problem ${pyRepr(problem.id)} exists; pass overwrite=true to replace it` };
    }
    if (!report.ok && !report.skipped) return { saved: false, ...report };
    await this.saveProblem(problem, yaml);
    this.broadcast({ type: "problems_changed" });
    this.broadcast({ type: "problem_changed", problem_id: problem.id });
    return { saved: true, path: `problems/${problem.id}.yaml`, validated: !!report.ok, ...report };
  }

  async saveProblem(problem: FullProblem, yaml: string) {
    const rec: ProblemRecord = { id: problem.id, yaml, problem, source: "user", updated_at: this.clock.now() };
    await this.db.put("problems", rec);
    await this.db.update<string[]>("meta", "deleted_seeds", (old) => (old ?? []).filter((x) => x !== problem.id));
  }

  async updateProblem(problemId: string, yaml: string): Promise<Dict> {
    if (!(await this.db.get("problems", problemId))) return { saved: false, errors: `no problem ${pyRepr(problemId)}` };
    const parsed = await this.runner.parse(yaml);
    if (!parsed.ok || !parsed.problem) return { saved: false, ok: false, stage: "schema", errors: parsed.errors };
    if (parsed.problem.id !== problemId) return { saved: false, errors: "the YAML id must equal problem_id" };
    return this.createProblem(yaml, true);
  }

  async deleteProblem(problemId: string, deleteUserCode = false): Promise<Dict> {
    const rec = await this.db.get<ProblemRecord>("problems", problemId);
    if (rec) {
      await this.db.delete("problems", problemId);
      await this.db.deletePrefix("assets", `${problemId}/`);
      if (rec.source === "seed") {
        // keep a shipped problem from coming back with the next seed sync
        await this.db.update<string[]>("meta", "deleted_seeds", (old) => [...new Set([...(old ?? []), problemId])]);
      }
    }
    if (deleteUserCode) await this.db.delete("workspace", problemId);
    this.broadcast({ type: "problems_changed" });
    return { deleted: !!rec };
  }

  // ---------------------------------------------------------------- tutoring

  async getSession(): Promise<Dict> {
    const s = this.session;
    const rec = s.problem_id ? await this.db.get<ProblemRecord>("problems", s.problem_id) : undefined;
    if (!rec) return { problem_id: null, message: "The user has no problem open." };
    const p = rec.problem;
    const w = await this.ws(p.id);
    const proposals = (w.state.proposals as ProposalRecord[] | undefined) ?? [];
    return {
      problem_id: p.id,
      title: p.title,
      environment: p.environment,
      judge: p.judge.kind,
      description: p.description,
      user_files: await this.currentFiles(p),
      readonly_files: Object.fromEntries(
        p.files.filter((f) => f.role === "readonly").map((f) => [f.path, f.content ?? ""]),
      ),
      active_file: s.active_file,
      cursor: s.cursor,
      selection: s.selection,
      hints_revealed: ((w.state.hints as { revealed: number } | undefined) ?? { revealed: 0 }).revealed,
      hints_total: (p.hints ?? []).length,
      last_run: briefRun((w.state.last_run as Dict | undefined) ?? null),
      custom_tests: w.state.custom_tests ?? [],
      annotations: w.state.annotations ?? [],
      pending_proposals: proposals.map(({ content: _content, ...rest }) => rest),
      seconds_since_activity: s.updated_at ? Math.round((this.clock.now() - s.updated_at) * 10) / 10 : null,
    };
  }

  async openProblem(problemId: string): Promise<Dict> {
    const p = await this.problem(problemId);
    this.broadcast({ type: "navigate", problem_id: p.id });
    return { opened: p.id };
  }

  async runTests(problemId?: string | null, full = false): Promise<Dict> {
    const p = await this.problem(problemId);
    const result = await this.run(p, { files: await this.currentFiles(p), source: "webmcp" });
    return briefRun(result as unknown as Dict, full) ?? {};
  }

  // annotations

  listAnnotations(problemId: string): Promise<AnnotationRecord[]> {
    return this.state(problemId, "annotations", [] as AnnotationRecord[]);
  }

  private async saveAnnotations(problemId: string, items: AnnotationRecord[]) {
    await this.writeState(problemId, "annotations", items);
    this.broadcast({ type: "annotations_changed", problem_id: problemId, annotations: items });
  }

  async annotate(items: AnnotationRequest[], problemId?: string | null, author = "assistant") {
    if (!Array.isArray(items)) throw new InvalidError("items must be a list of annotations");
    const p = await this.problem(problemId);
    const created = makeAnnotations(p, await this.currentFiles(p), items, author, this.clock);
    await this.saveAnnotations(p.id, [...(await this.listAnnotations(p.id)), ...created]);
    return created;
  }

  async removeAnnotation(problemId: string, annotationId: string): Promise<boolean> {
    const items = await this.listAnnotations(problemId);
    const kept = withoutAnnotations(items, { annotation_id: annotationId });
    await this.saveAnnotations(problemId, kept);
    return kept.length !== items.length;
  }

  async clearAnnotations(problemId?: string | null, file?: string | null): Promise<number> {
    const p = await this.problem(problemId);
    const items = await this.listAnnotations(p.id);
    const kept = withoutAnnotations(items, { file, clear: true });
    await this.saveAnnotations(p.id, kept);
    return items.length - kept.length;
  }

  // proposals

  listProposals(problemId: string): Promise<ProposalRecord[]> {
    return this.state(problemId, "proposals", [] as ProposalRecord[]);
  }

  private async saveProposals(problemId: string, items: ProposalRecord[], added = false) {
    await this.writeState(problemId, "proposals", items);
    this.broadcast({ type: "proposals_changed", problem_id: problemId, proposals: items, added });
  }

  async proposeEdit(
    file: string,
    opts: { rationale?: string; content?: string | null; edits?: { old?: string; new?: string }[] | null; problemId?: string | null; author?: string; source?: Source },
  ) {
    const p = await this.problem(opts.problemId);
    const proposal = makeProposal(
      p,
      await this.currentFiles(p),
      file,
      { content: opts.content, edits: opts.edits, rationale: opts.rationale ?? "", author: opts.author ?? "assistant", source: opts.source ?? "webmcp" },
      this.clock,
    );
    await this.saveProposals(p.id, withProposal(await this.listProposals(p.id), proposal), true);
    return proposal;
  }

  async resolveProposal(problemId: string, proposalId: string, action: string): Promise<Record<string, string>> {
    if (action !== "accept" && action !== "reject") throw new InvalidError("action must be accept or reject");
    const p = await this.problem(problemId);
    const items = await this.listProposals(p.id);
    const proposal = items.find((x) => x.id === proposalId);
    if (!proposal) throw new NotFoundError(`no pending proposal ${pyRepr(proposalId)}`);
    await this.saveProposals(p.id, items.filter((x) => x.id !== proposalId));
    if (action === "reject") return {};
    const written = { [proposal.file]: proposal.content };
    await this.writeFiles(p, written);
    if (this.session.problem_id === p.id) this.session.buffers[proposal.file] = proposal.content;
    this.broadcast({ type: "files_changed", problem_id: p.id, files: written, reason: "proposal_accepted" });
    return written;
  }

  async addTestCase(args: unknown, opts: { kwargs?: Record<string, unknown> | null; name?: string | null; description?: string | null; section?: string | null; problemId?: string | null } = {}) {
    const p = await this.problem(opts.problemId);
    const tests = await this.state(p.id, "custom_tests", [] as CustomTestRecord[]);
    tests.push(makeCustomTest(p, tests, args, opts.kwargs, opts.name, opts.description, opts.section));
    await this.setCustomTests(p.id, tests);
    return { custom_tests: tests.length };
  }

  // ---------------------------------------------------------------- workspace (UI)

  async workspaceView(problemId: string) {
    const p = await this.problem(problemId);
    const w = await this.ws(p.id);
    return {
      files: await this.workspaceFiles(p),
      custom_tests: (w.state.custom_tests as CustomTestRecord[] | undefined) ?? [],
      last_run: (w.state.last_run as RunResult | undefined) ?? null,
      annotations: (w.state.annotations as AnnotationRecord[] | undefined) ?? [],
      proposals: (w.state.proposals as ProposalRecord[] | undefined) ?? [],
      hints_revealed: ((w.state.hints as { revealed: number } | undefined) ?? { revealed: 0 }).revealed,
    };
  }

  /** Write editable files; returns the ones whose content changed. */
  private async writeFiles(p: FullProblem, files: Record<string, string>): Promise<Record<string, string>> {
    const editable = new Set(editableFiles(p).map((f) => f.path));
    for (const path of Object.keys(files)) {
      if (!editable.has(path)) throw new InvalidError(`${pyRepr(path)} is not an editable file of ${p.id}`);
    }
    const current = await this.workspaceFiles(p);
    const written: Record<string, string> = {};
    await this.db.update<WorkspaceRecord>("workspace", p.id, (old) => {
      const w = old ?? { id: p.id, files: {}, state: {} };
      const next = { ...w.files };
      for (const [path, content] of Object.entries(files)) {
        if (current[path] !== content || !(path in w.files)) {
          if (current[path] !== content) written[path] = content;
          next[path] = content;
        }
      }
      return { ...w, files: next };
    });
    if (Object.keys(written).length) this.requestPersistence();
    return written;
  }

  async saveFiles(problemId: string, files: Record<string, string>) {
    const written = await this.writeFiles(await this.problem(problemId), files);
    return { written: Object.keys(written).sort() };
  }

  async resetWorkspace(problemId: string) {
    const p = await this.problem(problemId);
    const starter = Object.fromEntries(editableFiles(p).map((f) => [f.path, f.content]));
    await this.db.update<WorkspaceRecord>("workspace", p.id, (old) => ({ ...(old ?? { id: p.id, state: {} }), files: starter }));
    return { files: starter };
  }

  async setCustomTests(problemId: string, tests: CustomTestRecord[], broadcast = true) {
    if (!Array.isArray(tests)) throw new InvalidError("tests must be a list");
    const p = await this.problem(problemId);
    await this.writeState(p.id, "custom_tests", tests);
    if (broadcast) this.broadcast({ type: "custom_tests_changed", problem_id: p.id, tests: tests as never });
    return { tests };
  }

  async setHints(problemId: string, revealed: number) {
    const p = await this.problem(problemId);
    const n = Math.max(0, Math.min(Math.trunc(revealed) || 0, (p.hints ?? []).length));
    await this.writeState(p.id, "hints", { revealed: n });
    return { revealed: n };
  }

  reportSession(fields: Partial<Omit<Session, "updated_at">>) {
    Object.assign(this.session, fields, { updated_at: this.clock.now() });
    return { ok: true };
  }

  async executorsFor(problemId?: string | null) {
    const caps = await this.capabilities();
    let requires: string[] = [];
    let env: Environment | null = null;
    if (problemId) {
      const p = await this.problem(problemId);
      env = this.environment(p);
      requires = requirements(p, env);
    }
    return {
      executors: [
        {
          ...this.describeExecutor(caps),
          compatible: problemId ? canRun(caps, "pyodide", requires, env) : true,
          device: deviceFor(caps, requires),
        },
      ],
      requires,
      runtimes: [...runtimes(env)].sort(),
    };
  }

  // ---------------------------------------------------------------- runs

  /** Run the user's code (given buffers, else what is saved) and record last_run. */
  async run(
    p: FullProblem,
    opts: { files?: Record<string, string> | null; executor?: string | null; runId?: string | null; source?: string } = {},
  ): Promise<RunResult> {
    if (opts.files && Object.keys(opts.files).length) await this.writeFiles(p, opts.files);
    const runId = opts.runId || this.clock.newId() + this.clock.newId().slice(0, 2);
    const source = opts.source ?? "ui";
    return this.withRunLock(p.id, async () => {
      this.broadcast({ type: "run_started", problem_id: p.id, run_id: runId, source });
      const off = this.runner.onNotice((n) => {
        if (n.type === "status" && n.run_id === runId) {
          this.broadcast({ type: "run_status", problem_id: p.id, run_id: runId, phase: n.phase, detail: n.detail });
        }
      });
      let result: RunResult;
      const started = this.clock.now();
      try {
        result = await this.execute(p, runId, await this.workspaceFiles(p));
      } catch (e) {
        result = errorResult(p.id, runId, String((e as Error).message ?? e), started);
      } finally {
        off();
      }
      await this.writeState(p.id, "last_run", result);
      this.broadcast({ type: "run_finished", problem_id: p.id, run_id: runId, source, result });
      return result;
    });
  }

  private async execute(p: FullProblem, runId: string, files: Record<string, string>): Promise<RunResult> {
    const env = this.environment(p);
    const requires = requirements(p, env);
    const caps = await this.capabilities();
    if (!env) return errorResult(p.id, runId, `unknown environment ${pyRepr(p.environment)}`, this.clock.now());
    if (!canRun(caps, "pyodide", requires, env)) {
      const why = !runtimes(env).has("pyodide")
        ? `the ${pyRepr(env.id)} environment runs only on the local/remote edition (native executors). ` +
          "Export this problem and run it with the leegen server."
        : `this browser does not provide ${requires.filter((r) => !caps.includes(r)).join(", ")}` +
          (requires.includes("webgpu") ? " (WebGPU is unavailable here; try a current Chrome, Edge or Safari)" : "");
      return errorResult(p.id, runId, why, this.clock.now());
    }
    const rec = await this.record(p.id);
    return this.runner.run({
      run_id: runId,
      problem_yaml: rec.yaml,
      files,
      mode: "user",
      custom_tests: await this.state(p.id, "custom_tests", [] as never[]),
      only_visible: false,
      packages: env.browser?.packages ?? [],
      device: deviceFor(caps, requires),
    });
  }

  async cancel(runId: string) {
    try {
      return await this.runner.cancel(runId);
    } catch {
      return { cancelled: false };
    }
  }

  private withRunLock<T>(problemId: string, fn: () => Promise<T>): Promise<T> {
    const name = `leegen-run:${problemId}`;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (locks) return locks.request(name, fn) as Promise<T>;
    const prev = this.localLocks.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.localLocks.set(name, next.catch(() => undefined));
    return next;
  }

  /** Ask once for persistent storage, when the user first saves work (Safari evicts after
   * 7 days of no visits otherwise). */
  private requestPersistence() {
    if (this.persistAsked || typeof navigator === "undefined" || !navigator.storage?.persist) return;
    this.persistAsked = true;
    navigator.storage.persisted().then((done) => done || navigator.storage.persist()).catch(() => undefined);
  }

  // ---------------------------------------------------------------- assets

  async assetBlob(problemId: string, src: string): Promise<Blob | undefined> {
    const rel = src.replace(/^\.\//, "");
    return this.db.get<Blob>("assets", `${problemId}/${rel}`);
  }
}

export function errorResult(problemId: string, runId: string, error: string, started: number): RunResult {
  return {
    run_id: runId,
    problem_id: problemId,
    mode: "user",
    status: "error",
    executor: EXECUTOR_ID,
    device: null,
    started_at: started,
    duration_ms: 0,
    passed: 0,
    total: 0,
    tests: [],
    metrics: [],
    compile_output: null,
    error,
    stdout: "",
    stderr: "",
  } as RunResult;
}

function waitFor(cond: () => boolean, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => (cond() || Date.now() - t0 > timeoutMs ? resolve() : setTimeout(tick, 50));
    tick();
  });
}
