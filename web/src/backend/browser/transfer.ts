// Export / import in the repo layout, so work moves between the browser and a local checkout:
//
//   problems/<id>.yaml
//   problems/<id>/assets/...
//   workspace/<id>/<editable files>
//   workspace/<id>/.leetclaude/<state>.json      (custom_tests, last_run, annotations, ...)
//
// Unzip an export at the repo root and the local server sees the same problems and work; zip a
// checkout's problems/ and workspace/ folders and import them here.

import type { Db, ProblemRecord, WorkspaceRecord } from "./db.ts";
import type { RunnerClient } from "./runner.ts";
import type { BrowserToolService } from "./service.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

export interface ImportSummary {
  problems: string[];
  unchanged: string[];
  workspaces: string[];
  errors: { path: string; error: string }[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATE_DIR = ".leetclaude";
const SAFE_SEGMENT = /^(?!\.\.?$)[^/\\\0]+$/;

export async function exportZip(db: Db, seedAssets: (id: string, rel: string) => Promise<Blob | undefined>): Promise<Blob> {
  const entries: ZipEntry[] = [];
  const problems = await db.all<ProblemRecord>("problems");
  const assetKeys = (await db.keys("assets")).map(String);
  for (const rec of problems.sort((a, b) => a.id.localeCompare(b.id))) {
    entries.push({ path: `problems/${rec.id}.yaml`, data: enc.encode(rec.yaml) });
    const own = assetKeys.filter((k) => k.startsWith(`${rec.id}/`));
    for (const key of own) {
      const blob = await db.get<Blob>("assets", key);
      if (blob) entries.push({ path: `problems/${key}`, data: new Uint8Array(await blob.arrayBuffer()) });
    }
    if (rec.source === "seed" && !own.length) {
      for (const rel of rec.assets ?? []) {
        const blob = await seedAssets(rec.id, rel);
        if (blob) entries.push({ path: `problems/${rec.id}/${rel}`, data: new Uint8Array(await blob.arrayBuffer()) });
      }
    }
  }
  for (const w of await db.all<WorkspaceRecord>("workspace")) {
    for (const [path, content] of Object.entries(w.files)) {
      entries.push({ path: `workspace/${w.id}/${path}`, data: enc.encode(content) });
    }
    for (const [name, value] of Object.entries(w.state)) {
      if (value === undefined) continue;
      entries.push({ path: `workspace/${w.id}/${STATE_DIR}/${name}.json`, data: enc.encode(JSON.stringify(value, null, 2)) });
    }
  }
  return writeZip(entries);
}

/** Paths relative to the repo root: tolerate one leading folder (a zipped checkout). */
function normalise(entries: ZipEntry[]): ZipEntry[] {
  const atRoot = entries.some((e) => /^(problems|workspace)\//.test(e.path));
  return entries
    .map((e) => ({ ...e, path: e.path.replace(/\\/g, "/") }))
    .map((e) => (atRoot ? e : { ...e, path: e.path.replace(/^[^/]+\//, "") }))
    .filter((e) => e.path.split("/").every((s) => SAFE_SEGMENT.test(s)) && !e.path.split("/").includes("__MACOSX"));
}

export async function importZip(blob: Blob, db: Db, runner: RunnerClient, service: BrowserToolService): Promise<ImportSummary> {
  const summary: ImportSummary = { problems: [], unchanged: [], workspaces: [], errors: [] };
  const entries = normalise(await readZip(blob));

  // problems first, so workspace files can be checked against them
  for (const e of entries) {
    const m = e.path.match(/^problems\/([^/]+)\.ya?ml$/);
    if (!m) continue;
    const yaml = dec.decode(e.data);
    const existing = await db.get<ProblemRecord>("problems", m[1]);
    if (existing && existing.yaml === yaml) {
      summary.unchanged.push(m[1]);
      continue;
    }
    const parsed = await runner.parse(yaml);
    if (!parsed.ok || !parsed.problem) {
      summary.errors.push({ path: e.path, error: parsed.errors ?? "invalid problem" });
      continue;
    }
    if (parsed.problem.id !== m[1]) {
      summary.errors.push({ path: e.path, error: `id ${parsed.problem.id!} must equal the file name` });
      continue;
    }
    await service.saveProblem(parsed.problem, yaml);
    summary.problems.push(m[1]);
  }

  for (const e of entries) {
    const m = e.path.match(/^problems\/([^/]+)\/(assets\/.+)$/);
    if (!m || !(await db.get("problems", m[1]))) continue;
    await db.put("assets", new Blob([e.data as BlobPart]), `${m[1]}/${m[2]}`);
  }

  const touched = new Set<string>();
  for (const e of entries) {
    const m = e.path.match(/^workspace\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, id, rel] = m;
    if (!(await db.get("problems", id))) {
      summary.errors.push({ path: e.path, error: `no problem ${id} for this workspace file` });
      continue;
    }
    const state = rel.match(new RegExp(`^${STATE_DIR.replace(".", "\\.")}/([a-z_]+)\\.json$`));
    if (rel.startsWith(`${STATE_DIR}/`) && !state) continue;
    let value: unknown;
    if (state) {
      try {
        value = JSON.parse(dec.decode(e.data));
      } catch (err) {
        summary.errors.push({ path: e.path, error: `not JSON: ${(err as Error).message}` });
        continue;
      }
    }
    await db.update<WorkspaceRecord>("workspace", id, (old) => {
      const w = old ?? { id, files: {}, state: {} };
      return state
        ? { ...w, state: { ...w.state, [state[1]]: value } }
        : { ...w, files: { ...w.files, [rel]: dec.decode(e.data) } };
    });
    touched.add(id);
  }
  summary.workspaces = [...touched].sort();
  return summary;
}
