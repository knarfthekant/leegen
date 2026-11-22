// Export / import in the data layout: the same tree as the local server's data folder (`data/`,
// or wherever LEEGEN_DATA points), so work moves between the browser and a local install:
//
//   problems/<id>.yaml
//   problems/<id>/assets/...
//   tutorials/<id>.yaml
//   workspace/<id>/<editable files>
//   workspace/<id>/.leegen/<state>.json      (custom_tests, last_run, annotations, ...)
//   workspace/tut-<id>/cells/<cell>.py       (a tutorial's work; .leegen/cell_results.json too)
//
// Unzip an export into the data folder and the local server sees the same problems, tutorials and
// work. Import accepts that tree, the data folder itself, or a whole checkout (its `data/` is
// found). Zip export and import are the only way data leaves or enters the browser store.

import type { ImportSummary } from "../types";
import type { Db, ProblemRecord, TutorialRecord, WorkspaceRecord } from "./db.ts";
import type { RunnerClient } from "./runner.ts";
import type { BrowserToolService } from "./service.ts";
import { isShimId, SHIM_PREFIX } from "./tutorial.ts";
import type { BrowserTutorialService } from "./tutorials.ts";
import { readZip, writeZip, type ZipEntry } from "./zip.ts";

export type { ImportSummary };

const enc = new TextEncoder();
const dec = new TextDecoder();
const STATE_DIR = ".leegen";
const SAFE_SEGMENT = /^(?!\.\.?$)[^/\\\0]+$/;

/** Everything in the data layout: problems, assets, tutorials, the user's files and state. */
export async function collectEntries(db: Db, seedAssets: (id: string, rel: string) => Promise<Blob | undefined>): Promise<ZipEntry[]> {
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
  for (const t of (await db.all<TutorialRecord>("tutorials")).sort((a, b) => a.id.localeCompare(b.id))) {
    entries.push({ path: `tutorials/${t.id}.yaml`, data: enc.encode(t.yaml) });
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
  return entries;
}

export async function exportZip(db: Db, seedAssets: (id: string, rel: string) => Promise<Blob | undefined>): Promise<Blob> {
  return writeZip(await collectEntries(db, seedAssets));
}

const DATA_ROOT = /^((?:[^/]+\/){0,2})(problems|workspace|tutorials)\//;

/** Paths relative to the data root: drop whatever precedes it (a zipped data folder or checkout). */
export function normalise(entries: ZipEntry[]): ZipEntry[] {
  const slashed = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, "/") }));
  const prefixes = slashed.flatMap((e) => DATA_ROOT.exec(e.path)?.[1] ?? []);
  // the shortest prefix is the data root; `data/problems` beats `data/problems/x/problems`
  const prefix = prefixes.reduce((a, b) => (b.length < a.length ? b : a), prefixes[0] ?? "");
  return slashed
    .filter((e) => e.path.startsWith(prefix))
    .map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
    .filter((e) => e.path.split("/").every((s) => SAFE_SEGMENT.test(s)) && !e.path.split("/").includes("__MACOSX"));
}

export interface ImportDeps {
  db: Db;
  runner: RunnerClient;
  service: BrowserToolService;
  tutorials: BrowserTutorialService;
}

export async function importZip(blob: Blob, deps: ImportDeps): Promise<ImportSummary> {
  return importEntries(await readZip(blob), deps);
}

/** Import data-layout entries. */
export async function importEntries(raw: ZipEntry[], { db, runner, service, tutorials }: ImportDeps): Promise<ImportSummary> {
  const summary: ImportSummary = { problems: [], tutorials: [], unchanged: [], workspaces: [], errors: [] };
  const entries = normalise(raw);

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

  for (const e of entries) {
    const m = e.path.match(/^tutorials\/([^/]+)\.ya?ml$/);
    if (!m) continue;
    const yaml = dec.decode(e.data);
    if ((await db.get<TutorialRecord>("tutorials", m[1]))?.yaml === yaml) {
      summary.unchanged.push(m[1]);
      continue;
    }
    const parsed = await tutorials.parse(yaml);
    if (!parsed.ok) {
      summary.errors.push({ path: e.path, error: parsed.errors });
    } else if (parsed.parsed.tutorial.id !== m[1]) {
      summary.errors.push({ path: e.path, error: `id ${parsed.parsed.tutorial.id} must equal the file name` });
    } else {
      await tutorials.save(m[1], yaml, parsed.parsed);
      summary.tutorials.push(m[1]);
    }
  }

  const touched = new Set<string>();
  for (const e of entries) {
    const m = e.path.match(/^workspace\/([^/]+)\/(.+)$/);
    if (!m) continue;
    const [, id, rel] = m;
    const owner = isShimId(id) ? await db.get("tutorials", id.slice(SHIM_PREFIX.length)) : await db.get("problems", id);
    if (!owner) {
      summary.errors.push({ path: e.path, error: `no ${isShimId(id) ? "tutorial" : "problem"} ${isShimId(id) ? id.slice(SHIM_PREFIX.length) : id} for this workspace file` });
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
