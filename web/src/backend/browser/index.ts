// The browser edition's Backend: IndexedDB + the separate-origin Pyodide runner (+ WebMCP tools,
// registered on this top-level page so Codex and other in-browser agents can tutor and author).

import type { Problem, WorkspaceState } from "../../lib/api";
import type { Backend, BackendStatus, ExecutorListing, ProblemListing } from "../types";
import { publicProblem, type Environment, type FullProblem } from "./core.ts";
import { Db, type ProblemRecord } from "./db.ts";
import { EventHub } from "./events.ts";
import { RunnerClient } from "./runner.ts";
import { BrowserToolService, type Guides } from "./service.ts";
import { folderName, folderSupported, readFolder, saveToFolder } from "./folder.ts";
import { collectEntries, exportZip, importEntries, importZip } from "./transfer.ts";

interface AppConfig {
  runner_origin: string;
  version: string;
}

export interface SeedBundle {
  version: string;
  problems: { id: string; yaml: string; problem: FullProblem; assets: string[] }[];
  environments: Environment[];
  guides: Guides;
  schema: unknown;
  tools: { tools: unknown[] };
}

const BASE = import.meta.env.BASE_URL;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/** Bring shipped problems up to date. User-created or imported problems are never touched, and
 * shipped problems the user deleted stay deleted. */
async function syncSeeds(db: Db, bundle: SeedBundle) {
  if ((await db.get<string>("meta", "seed_version")) === bundle.version) return;
  const deleted = new Set((await db.get<string[]>("meta", "deleted_seeds")) ?? []);
  const shipped = new Set(bundle.problems.map((p) => p.id));
  for (const s of bundle.problems) {
    const existing = await db.get<ProblemRecord>("problems", s.id);
    if (deleted.has(s.id) || (existing && existing.source !== "seed")) continue;
    await db.put("problems", {
      id: s.id,
      yaml: s.yaml,
      problem: s.problem,
      source: "seed",
      seed_version: bundle.version,
      assets: s.assets,
      updated_at: Date.now() / 1000,
    } satisfies ProblemRecord);
  }
  for (const rec of await db.all<ProblemRecord>("problems")) {
    if (rec.source === "seed" && !shipped.has(rec.id)) await db.delete("problems", rec.id);
  }
  await db.put("meta", bundle.version, "seed_version");
}

export interface BrowserBackend extends Backend {
  service: BrowserToolService;
  bundle: SeedBundle;
}

export async function createBrowserBackend(): Promise<BrowserBackend> {
  const [config, bundle, db] = await Promise.all([
    fetchJson<AppConfig>("config.json"),
    fetchJson<SeedBundle>("data/bundle.json"),
    Db.open(),
  ]);
  await syncSeeds(db, bundle);

  const hub = new EventHub();
  const runner = new RunnerClient(config.runner_origin);
  const service = new BrowserToolService({
    db,
    hub,
    runner,
    environments: bundle.environments,
    guides: bundle.guides,
    schema: bundle.schema,
  });

  // ------------------------------------------------------------ service status
  const statusListeners = new Set<() => void>();
  let agentTools: number | null = null;
  let agentError: string | null = null;
  const computeStatus = (): BackendStatus => {
    const toolCount = bundle.tools.tools.length;
    return { services: [
      { id: "browser", label: "Browser", state: "online", detail: "Local storage is ready. Problems and your work are saved in this browser." },
      {
        id: "runner", label: "Python runner",
        state: runner.state === "failed" ? "offline" : runner.state === "ready" ? "online" : "connecting",
        detail: runner.state === "failed" ? runner.error ?? "The Python runner failed."
          : runner.state === "ready" ? `Runner connected at ${runner.origin}. Python loads when needed.`
          : `Connecting to the Python runner at ${runner.origin}…`,
      },
      {
        id: "webmcp", label: "WebMCP",
        state: agentError ? "offline" : agentTools === null ? "connecting"
          : agentTools === 0 ? "unavailable" : agentTools < toolCount ? "degraded" : "online",
        detail: agentError ?? (agentTools === null ? "Registering agent tools…"
          : agentTools === 0 ? "WebMCP is unavailable in this browser. Use a browser with WebMCP support to connect an agent."
          : `${agentTools} of ${toolCount} agent tools registered. Tools are available to agents in this browser.`),
      },
    ] };
  };
  let status = computeStatus();
  const refresh = () => {
    status = computeStatus();
    statusListeners.forEach((l) => l());
  };
  runner.onState = refresh;

  const seedAsset = async (id: string, rel: string) => {
    const res = await fetch(`${BASE}data/assets/${id}/${rel}`);
    return res.ok ? res.blob() : undefined;
  };
  const objectUrls = new Map<string, string>();

  const backend: BrowserBackend = {
    edition: "browser",
    getAgentStatus: () => service.getAgentStatus(),
    service,
    bundle,

    listProblems: () => service.problemListView() as Promise<ProblemListing>,
    getProblem: async (id) => publicProblem(await service.problem(id)) as unknown as Problem,
    getWorkspace: (id) => service.workspaceView(id) as unknown as Promise<WorkspaceState>,
    saveFiles: (id, files) => service.saveFiles(id, files),
    resetWorkspace: (id) => service.resetWorkspace(id),
    saveCustomTests: (id, tests) => service.setCustomTests(id, tests as never, false),
    saveHints: (id, revealed) => service.setHints(id, revealed),

    async run(problemId, files, executor, runId) {
      const p = await service.problem(problemId);
      return service.run(p, { files, executor, runId, source: "ui" });
    },
    cancel: (runId) => service.cancel(runId),
    async executors(problemId) {
      runner.warm().catch(() => undefined);   // start Python while the user reads the problem
      return (await service.executorsFor(problemId)) as unknown as ExecutorListing;
    },

    reportSession: async (report) => service.reportSession(report),
    resolveProposal: async (id, proposalId, action) => ({
      files: await service.resolveProposal(id, proposalId, action),
    }),
    deleteAnnotation: (id, annotationId) => service.removeAnnotation(id, annotationId),

    async assetUrl(problemId, src) {
      const rel = src.replace(/^\.\//, "");
      const key = `${problemId}/${rel}`;
      if (objectUrls.has(key)) return objectUrls.get(key);
      const own = await service.assetBlob(problemId, rel);
      if (own) {
        const url = URL.createObjectURL(own);
        objectUrls.set(key, url);
        return url;
      }
      const rec = await service.record(problemId).catch(() => undefined);
      return rec?.source === "seed" && rec.assets?.includes(rel) ? `${BASE}data/assets/${problemId}/${rel}` : undefined;
    },

    subscribe: (listener) => hub.subscribe(listener),
    status: {
      get: () => status,
      subscribe(listener) {
        statusListeners.add(listener);
        // Establish the lightweight runner channel without loading Python yet.
        void runner.connect().catch(() => undefined);
        return () => statusListeners.delete(listener);
      },
    },

    transfer: {
      exportZip: () => exportZip(db, seedAsset),
      async importZip(file) {
        const summary = await importZip(file, db, runner, service);
        hub.broadcast({ type: "problems_changed" });
        return summary;
      },
      folder: folderSupported()
        ? {
            name: () => folderName(db),
            save: async (pickNew) => saveToFolder(db, await collectEntries(db, seedAsset), pickNew),
            async load(pickNew) {
              const { folder, entries } = await readFolder(db, pickNew);
              const summary = await importEntries(entries, db, runner, service);
              hub.broadcast({ type: "problems_changed" });
              return { ...summary, folder };
            },
          }
        : undefined,
    },
  };

  // Offline: the app shell and data are cached by a service worker (the runner has its own).
  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register(`${BASE}sw.js`).catch((e) => console.warn("service worker:", e));
  }

  // WebMCP: register the agent tools on this (top-level) page.
  void import("./tools.ts").then(({ registerAgentTools }) => registerAgentTools(service, bundle.tools.tools as never))
    .then((n) => {
      agentTools = n;
      if (n === 0 && (document.modelContext ?? navigator.modelContext)?.registerTool) {
        agentError = "WebMCP is available, but its agent tools could not be registered. Reload to try again.";
      }
    })
    .catch((e) => { agentError = `Agent tools could not be registered: ${String(e?.message ?? e)}`; })
    .finally(refresh);

  return backend;
}
