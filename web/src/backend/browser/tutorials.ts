// BrowserTutorialService: the browser edition's counterpart of the server's TutorialService
// (server/src/leegen/tutorial_service.py), behind the same `TutorialApi` the UI uses.
//
// Tutorials live in the `tutorials` store; the learner's code and cell outcomes live in the
// ordinary workspace store under the shim id `tut-<id>` (cells/<cell>.py, cell_results), which
// is also how the server lays them out under data/workspace/. A cell run is a console snippet
// (BrowserToolService.runConsole) with the earlier cells as `prior` and the hidden checks.
// Checks and references stay in this module: the UI only ever sees `publicTutorial`.

import type { ConsoleResult } from "../../contracts/generated";
import { newRunId, type CellOutcome, type Tutorial, type TutorialSummary } from "../../lib/api.ts";
import type { TutorialApi } from "../types";
import { canRun, deviceFor, InvalidError, NotFoundError, pyRepr, requirements, type FullProblem } from "./core.ts";
import type { Db, TutorialRecord, WorkspaceRecord } from "./db.ts";
import type { EventHub } from "./events.ts";
import type { RunnerClient } from "./runner.ts";
import type { BrowserToolService } from "./service.ts";
import {
  cellPath, cellRunInputs, codeCells, compareTutorials, publicTutorial, referenceFiles, referenceIssues,
  sessionCells, shimId, SHIM_PREFIX, starterIssues, isShimId, tutorialSummary, type FullTutorial,
} from "./tutorial.ts";

type Dict = Record<string, unknown>;

const RESULTS = "cell_results";
type Results = Record<string, CellOutcome>;

export interface TutorialDeps {
  db: Db;
  hub: EventHub;
  runner: RunnerClient;
  service: BrowserToolService;
}

/** What the runner's `parse_tutorial` returns for a valid tutorial. */
export interface ParsedTutorial {
  tutorial: FullTutorial;
  shim: string;
}

export class BrowserTutorialService implements TutorialApi {
  private deps: TutorialDeps;

  constructor(deps: TutorialDeps) {
    this.deps = deps;
  }

  // ---------------------------------------------------------------- lookups

  async record(id: string): Promise<TutorialRecord> {
    const rec = await this.deps.db.get<TutorialRecord>("tutorials", id);
    if (!rec) throw new NotFoundError(`no tutorial ${pyRepr(id)}`);
    return rec;
  }

  private async ws(id: string): Promise<WorkspaceRecord> {
    return (await this.deps.db.get<WorkspaceRecord>("workspace", shimId(id))) ?? { id: shimId(id), files: {}, state: {} };
  }

  private async results(id: string): Promise<Results> {
    return ((await this.ws(id)).state[RESULTS] as Results | undefined) ?? {};
  }

  /** The learner's code per cell file: saved text, else the cell's starter. */
  private async files(t: FullTutorial): Promise<Record<string, string>> {
    const saved = (await this.ws(t.id)).files;
    return Object.fromEntries(codeCells(t).map((c) => [cellPath(c.id), saved[cellPath(c.id)] ?? c.starter]));
  }

  private async writeWs(id: string, fn: (w: WorkspaceRecord) => WorkspaceRecord) {
    await this.deps.db.update<WorkspaceRecord>("workspace", shimId(id), (old) => fn(old ?? { id: shimId(id), files: {}, state: {} }));
  }

  // ---------------------------------------------------------------- TutorialApi

  async list() {
    const [recs, wss] = await Promise.all([
      this.deps.db.all<TutorialRecord>("tutorials"),
      this.deps.db.all<WorkspaceRecord>("workspace"),
    ]);
    const done = new Map(wss.map((w) => [w.id, (w.state[RESULTS] as Results | undefined) ?? {}]));
    const tutorials: TutorialSummary[] = recs.map((r) => {
      const results = done.get(shimId(r.id)) ?? {};
      return { ...tutorialSummary(r.tutorial), passed: codeCells(r.tutorial).filter((c) => results[c.id]?.passed).length };
    });
    return { tutorials: tutorials.sort(compareTutorials), errors: [] as { path: string; error: string }[] };
  }

  async get(id: string): Promise<Tutorial> {
    const { tutorial } = await this.record(id);
    const w = await this.ws(id);
    return {
      ...publicTutorial(tutorial), files: await this.files(tutorial), results: await this.results(id),
      annotations: (w.state.annotations as Tutorial["annotations"] | undefined) ?? [],
      proposals: (w.state.proposals as Tutorial["proposals"] | undefined) ?? [],
    };
  }

  async saveFiles(id: string, files: Record<string, string>) {
    const { tutorial } = await this.record(id);
    const editable = new Set(codeCells(tutorial).map((c) => cellPath(c.id)));
    for (const path of Object.keys(files)) {
      if (!editable.has(path)) throw new InvalidError(`${pyRepr(path)} is not a cell file of ${id}`);
    }
    await this.writeWs(id, (w) => ({ ...w, files: { ...w.files, ...files } }));
    this.deps.service.requestPersistence();
    return { written: Object.keys(files).sort() };
  }

  async reset(id: string, cellId?: string) {
    const { tutorial } = await this.record(id);
    if (!cellId) {
      await this.writeWs(id, (w) => ({ ...w, files: {}, state: { ...w.state, [RESULTS]: {} } }));
      return { files: await this.files(tutorial), results: {} as Results };
    }
    const cell = codeCells(tutorial).find((c) => c.id === cellId);
    if (!cell) throw new NotFoundError(`no cell ${pyRepr(cellId)}`);
    const { [cellId]: _dropped, ...rest } = await this.results(id);
    await this.writeWs(id, (w) => ({
      ...w, files: { ...w.files, [cellPath(cellId)]: cell.starter }, state: { ...w.state, [RESULTS]: rest },
    }));
    return { files: await this.files(tutorial), results: rest };
  }

  /** Run one cell on the learner's code and keep its outcome. `files` are live buffers: saved
   * first unless `save` is false (an agent's run must not persist unsaved text). */
  async runCell(
    id: string, cellId: string, files: Record<string, string>, runId: string,
    opts: { save?: boolean; source?: string } = {},
  ): Promise<ConsoleResult> {
    const rec = await this.record(id);
    const source = opts.source ?? "ui";
    if (Object.keys(files ?? {}).length && opts.save !== false) await this.saveFiles(id, files);
    const current = { ...(await this.files(rec.tutorial)), ...(opts.save === false ? files : {}) };
    const inputs = cellRunInputs(rec.tutorial, current, cellId);
    const shim = JSON.parse(rec.shim) as FullProblem;
    const result = await this.deps.service.runConsole(shim, {
      file: null, files: {}, code: inputs.code, stdin: inputs.stdin, prior: inputs.prior, checks: inputs.checks,
      problemYaml: rec.shim, runId, source,
    });
    const passed = result.status === "ok" && result.checks.length > 0 && result.checks.every((c) => c.status === "pass");
    const outcome: CellOutcome = { status: result.status, passed, checks: result.checks, ran_at: Date.now() / 1000 };
    await this.writeWs(id, (w) => ({ ...w, state: { ...w.state, [RESULTS]: { ...(w.state[RESULTS] as Results | undefined), [cellId]: outcome } } }));
    this.deps.hub.broadcast({ type: "tutorial_cell_finished", tutorial_id: id, cell: cellId, run_id: runId, source, result });
    return result;
  }

  cancel(runId: string) {
    return this.deps.service.cancel(runId);
  }

  // ---------------------------------------------------------------- import / seeds

  async save(id: string, yaml: string, parsed: ParsedTutorial, source: TutorialRecord["source"] = "user", seedVersion?: string) {
    const rec: TutorialRecord = {
      id, yaml, tutorial: parsed.tutorial, shim: parsed.shim, source,
      ...(seedVersion ? { seed_version: seedVersion } : {}), updated_at: Date.now() / 1000,
    };
    await this.deps.db.put("tutorials", rec);
  }

  /** Schema-check tutorial YAML in the runner (the Python core). */
  async parse(yaml: string): Promise<{ ok: true; parsed: ParsedTutorial } | { ok: false; errors: string }> {
    const r = await this.deps.runner.parseTutorial(yaml);
    return r.ok && r.tutorial && r.shim ? { ok: true, parsed: { tutorial: r.tutorial, shim: r.shim } } : { ok: false, errors: r.errors ?? "invalid tutorial" };
  }

  // ---------------------------------------------------------------- agent side

  guide(): string {
    return this.deps.service.tutorialGuide();
  }

  async agentList(track?: string | null) {
    const { tutorials, errors } = await this.list();
    return { tutorials: tutorials.filter((t) => !track || t.track === track), invalid_files: errors };
  }

  async agentGet(id: string, includeHidden = true): Promise<Dict> {
    const rec = await this.record(id);
    return includeHidden ? { id: rec.id, yaml: rec.yaml } : (publicTutorial(rec.tutorial) as unknown as Dict);
  }

  /** The rules of leegen.core.tutorial: every reference passes its checks, every starter fails one. */
  private async validate(t: FullTutorial, shim: string): Promise<Dict> {
    const svc = this.deps.service;
    const env = svc.environmentById(t.environment);
    if (!env || env.language !== "python") return { ok: false, issues: [`environment ${pyRepr(t.environment)} is not a Python one`] };
    const stand = JSON.parse(shim) as FullProblem;
    const requires = requirements(stand, env);
    const caps = await svc.capabilities();
    if (!canRun(caps, "pyodide", requires, env)) {
      return {
        ok: false, skipped: true, summary: `${pyRepr(t.environment)} does not run in the browser edition; not run`,
        issues: ["validate it with the local leegen server"],
      };
    }
    const issues: string[] = [];
    const ref = referenceFiles(t);
    for (const c of codeCells(t)) {
      if (!c.checks.length) continue;
      for (const wantPass of [true, false]) {
        const files = wantPass ? ref : { ...ref, [cellPath(c.id)]: c.starter };
        const inputs = cellRunInputs(t, files, c.id);
        let result: ConsoleResult;
        try {
          result = await this.deps.runner.runSnippet({
            run_id: newRunId(), problem_yaml: shim, files, mode: "snippet", custom_tests: [], only_visible: false,
            snippet: { file: null, code: inputs.code, stdin: inputs.stdin, prior: inputs.prior, checks: inputs.checks },
            packages: env.browser?.packages ?? [], device: deviceFor(caps, requires),
          });
        } catch (e) {
          issues.push(`cell ${c.id}: could not run: ${String((e as Error).message ?? e)}`);
          continue;
        }
        issues.push(...(wantPass ? referenceIssues : starterIssues)(c.id, result));
      }
    }
    const checked = codeCells(t).filter((c) => c.checks.length).length;
    return { ok: issues.length === 0, issues, summary: `${codeCells(t).length} code cells, ${checked} with checks` };
  }

  async validateYaml(yaml: string): Promise<{ parsed: ParsedTutorial | null; report: Dict }> {
    if (typeof yaml !== "string" || !yaml.trim()) throw new InvalidError("yaml must be the tutorial YAML text");
    const r = await this.parse(yaml);
    if (!r.ok) return { parsed: null, report: { ok: false, stage: "schema", errors: r.errors } };
    return { parsed: r.parsed, report: { stage: "run", ...(await this.validate(r.parsed.tutorial, r.parsed.shim)) } };
  }

  async create(yaml: string, overwrite = false): Promise<Dict> {
    const { parsed, report } = await this.validateYaml(yaml);
    if (!parsed) return { saved: false, ...report };
    const id = parsed.tutorial.id;
    if ((await this.deps.db.get("tutorials", id)) && !overwrite) {
      return { saved: false, ok: false, errors: `tutorial ${pyRepr(id)} exists; pass overwrite=true to replace it` };
    }
    if (!report.ok && !report.skipped) return { saved: false, ...report };
    await this.save(id, yaml, parsed);
    this.deps.hub.broadcast({ type: "tutorials_changed" });
    this.deps.hub.broadcast({ type: "tutorial_changed", tutorial_id: id });
    return { saved: true, path: `tutorials/${id}.yaml`, validated: !!report.ok, ...report };
  }

  async update(id: string, yaml: string): Promise<Dict> {
    if (!(await this.deps.db.get("tutorials", id))) return { saved: false, errors: `no tutorial ${pyRepr(id)}` };
    const r = await this.parse(yaml);
    if (!r.ok) return { saved: false, ok: false, stage: "schema", errors: r.errors };
    if (r.parsed.tutorial.id !== id) return { saved: false, errors: "the YAML id must equal tutorial_id" };
    return this.create(yaml, true);
  }

  async delete(id: string, deleteUserCode = false): Promise<Dict> {
    const rec = await this.deps.db.get<TutorialRecord>("tutorials", id);
    if (rec) await this.deps.db.delete("tutorials", id);
    if (deleteUserCode) await this.deps.db.delete("workspace", shimId(id));
    this.deps.hub.broadcast({ type: "tutorials_changed" });
    return { deleted: !!rec };
  }

  async navigate(id: string): Promise<Dict> {
    const { tutorial } = await this.record(id);
    this.deps.hub.broadcast({ type: "navigate_tutorial", tutorial_id: tutorial.id });
    return { opened: tutorial.id };
  }

  private openId(): string | null {
    const pid = this.deps.service.session.problem_id;
    return pid && isShimId(pid) ? pid.slice(SHIM_PREFIX.length) : null;
  }

  /** The learner's cells as they see them: unsaved editor buffers win over storage. */
  private async currentFiles(t: FullTutorial): Promise<Record<string, string>> {
    const files = await this.files(t);
    const s = this.deps.service.session;
    if (s.problem_id === shimId(t.id)) {
      for (const [path, content] of Object.entries(s.buffers)) if (path in files) files[path] = content;
    }
    return files;
  }

  /** Run a cell on the learner's current code, as the Run button does. */
  async runForAgent(tutorialId?: string | null, cell?: string | null): Promise<Dict> {
    const id = tutorialId || this.openId();
    if (!id) throw new InvalidError("no tutorial_id given and the user has no tutorial open");
    const { tutorial } = await this.record(id);
    const cells = codeCells(tutorial);
    const active = this.deps.service.session.active_file;
    const cellId = cell ?? cells.find((c) => cellPath(c.id) === active)?.id;
    if (!cellId) throw new InvalidError("no cell given and none is active; pass cell");
    if (!cells.some((c) => c.id === cellId)) {
      throw new NotFoundError(`no cell ${pyRepr(cellId)}; the code cells are ${cells.map((c) => c.id).join(", ")}`);
    }
    const r = await this.runCell(id, cellId, await this.currentFiles(tutorial), newRunId(), { save: false, source: "webmcp" });
    return {
      tutorial_id: id, cell: cellId, status: r.status,
      passed: r.status === "ok" && r.checks.length > 0 && r.checks.every((c) => c.status === "pass"),
      checks: r.checks, stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-4000), result: r.result, error: r.error,
    };
  }

  /** `get_session` while the user has a tutorial open. */
  async sessionView(): Promise<Dict> {
    const s = this.deps.service.session;
    const id = this.openId();
    const rec = id ? await this.deps.db.get<TutorialRecord>("tutorials", id) : undefined;
    if (!rec) return { problem_id: null, message: "The user has no problem open." };
    const t = rec.tutorial;
    const w = await this.ws(t.id);
    const proposals = (w.state.proposals as Dict[] | undefined) ?? [];
    return {
      kind: "tutorial", problem_id: shimId(t.id), tutorial_id: t.id, title: t.title, summary: t.summary,
      environment: t.environment,
      cells: sessionCells(t, await this.currentFiles(t), (w.state[RESULTS] as Results | undefined) ?? {}),
      active_cell: codeCells(t).find((c) => cellPath(c.id) === s.active_file)?.id ?? null,
      active_file: s.active_file, cursor: s.cursor, selection: s.selection,
      annotations: w.state.annotations ?? [],
      pending_proposals: proposals.map(({ content: _content, ...rest }) => rest),
      seconds_since_activity: s.updated_at ? Math.round((this.deps.service.now() - s.updated_at) * 10) / 10 : null,
    };
  }
}
