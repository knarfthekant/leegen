// App origin: capability probes, WebMCP site tools, and a separate-origin runner over RPC.

import { probeWebGPUInWorker, runComputeProbe } from "./shared/gpu.js";

const config = await (await fetch("./config.json", { cache: "no-store" })).json();
const RUNNER_ORIGIN = config.runner_origin;

const report = { generatedAt: null, userAgent: navigator.userAgent, sections: {} };
const notes = [];
const toolCalls = {};

// ---------------------------------------------------------------- rendering
const SECTION_TITLES = {
  app: "App origin",
  webmcp: "WebMCP site tools",
  runner: "Runner origin (separate site, iframe)",
  python: "Python in the runner (Pyodide)",
  validation: "Problem validation in Pyodide (real schema/models.py)",
  timeouts: "Timeouts and cancel",
};

function verdictOf(v) {
  if (v === undefined) return "pending";
  if (v && typeof v === "object" && "verdict" in v) return v.verdict;
  if (v === true) return "ok";
  if (v === false) return "bad";
  return null;
}

function render() {
  const root = document.getElementById("report");
  root.replaceChildren();
  for (const [key, title] of Object.entries(SECTION_TITLES)) {
    const section = report.sections[key];
    const card = document.createElement("section");
    card.className = "card";
    const h = document.createElement("h2");
    h.textContent = title;
    card.append(h);
    const table = document.createElement("table");
    if (!section) {
      table.innerHTML = `<tr><td colspan="2"><span class="pill pending">…</span>running</td></tr>`;
    } else {
      for (const [k, v] of Object.entries(section)) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.textContent = k;
        const val = document.createElement("td");
        const verdict = verdictOf(v);
        if (verdict) {
          const pill = document.createElement("span");
          pill.className = `pill ${verdict}`;
          pill.textContent = verdict === "ok" ? "ok" : verdict === "bad" ? "no" : verdict;
          val.append(pill);
        }
        const shown = v && typeof v === "object" && "verdict" in v ? v.detail : v;
        if (typeof shown !== "boolean" && shown !== undefined) {
          const code = document.createElement(typeof shown === "object" ? "pre" : "code");
          code.textContent = typeof shown === "object" ? JSON.stringify(shown, null, 1) : String(shown);
          val.append(code);
        }
        tr.append(name, val);
        table.append(tr);
      }
    }
    card.append(table);
    root.append(card);
  }
  document.getElementById("raw").textContent = JSON.stringify(report, null, 2);
  const ul = document.getElementById("notes");
  ul.replaceChildren(...(notes.length ? notes.map((n) => {
    const li = document.createElement("li");
    li.textContent = `${n.at} — ${n.message}`;
    return li;
  }) : [Object.assign(document.createElement("li"), { className: "muted", textContent: "none yet" })]));
}

const v = (ok, detail, warn = false) => ({ verdict: ok ? "ok" : warn ? "warn" : "bad", detail });

// ---------------------------------------------------------------- app-origin probes
async function probeApp() {
  let persisted = null, estimate = null, opfs = false;
  try { persisted = await navigator.storage?.persisted?.(); } catch { /* */ }
  try {
    const e = await navigator.storage?.estimate?.();
    estimate = e && { quotaMB: Math.round(e.quota / 1e6), usageMB: +(e.usage / 1e6).toFixed(2) };
  } catch { /* */ }
  try { await navigator.storage.getDirectory(); opfs = true; } catch { /* */ }
  const gpuPage = await runComputeProbe();
  const gpuWorker = await probeWebGPUInWorker(new URL("./shared/gpu-worker.js", import.meta.url));
  report.sections.app = {
    origin: location.origin,
    secureContext: window.isSecureContext,
    crossOriginIsolated: v(window.crossOriginIsolated === true, undefined),
    sharedArrayBuffer: typeof SharedArrayBuffer === "function",
    jspi: v(typeof WebAssembly !== "undefined" && "Suspending" in WebAssembly,
            "WebAssembly.Suspending (needed for asyncio.run inside Pyodide)", true),
    "webgpu (page)": v(!!gpuPage.computeOk, gpuPage, gpuPage.available),
    "webgpu (dedicated worker)": v(!!gpuWorker.computeOk, gpuWorker, gpuWorker.available),
    indexedDB: typeof indexedDB === "object",
    opfs,
    "storage.persisted()": persisted,
    "storage.estimate()": estimate,
    showDirectoryPicker: v(typeof window.showDirectoryPicker === "function",
                           "needed only for later folder sync", true),
    BroadcastChannel: typeof BroadcastChannel === "function",
    "Web Locks": !!navigator.locks,
    userAgentData: navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`).join(", ") ?? null,
  };
  render();
}

// ---------------------------------------------------------------- WebMCP
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) }] });
const counted = (name, fn) => async (input, ...rest) => {
  toolCalls[name] = (toolCalls[name] || 0) + 1;
  report.sections.webmcp && (report.sections.webmcp.calls = { ...toolCalls });
  render();
  return fn(input || {}, ...rest);
};

const TOOLS = [
  {
    name: "probe_get_report",
    title: "Get probe report",
    description: "Return the leegen browser-probe report: which capabilities this browser has " +
      "(cross-origin isolation, WebGPU, JSPI, storage), whether the separate-origin runner works, and " +
      "Python run results. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: counted("probe_get_report", async () => text(report)),
  },
  {
    name: "probe_rerun",
    title: "Re-run probes",
    description: "Run every probe again (takes ~10–30 s on first Python load) and return the new report.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false },
    execute: counted("probe_rerun", async () => { await runAll(); return text(report); }),
  },
  {
    name: "probe_annotate",
    title: "Add a note to the page",
    description: "Show a short note on the probe page, the way the real app's `annotate` tool shows " +
      "review comments. Input: {message: string, at most 500 characters}.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", maxLength: 500 } },
      required: ["message"], additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    // Codex does not enforce inputSchema, so validate here.
    execute: counted("probe_annotate", async (input) => {
      if (typeof input.message !== "string" || !input.message.trim() || input.message.length > 500) {
        return text({ error: "message must be a non-empty string of at most 500 characters" });
      }
      notes.push({ at: new Date().toLocaleTimeString(), message: input.message.trim() });
      render();
      return text({ ok: true, notes: notes.length });
    }),
  },
];

function registerTools() {
  const mc = document.modelContext ?? navigator.modelContext ?? null;
  const s = {
    "document.modelContext": "modelContext" in document,
    "navigator.modelContext": "modelContext" in navigator,
    registered: [],
    errors: [],
    calls: toolCalls,
  };
  if (mc?.registerTool) {
    for (const tool of TOOLS) {
      try { mc.registerTool(tool); s.registered.push(tool.name); } catch (e) {
        s.errors.push(`${tool.name}: ${e?.message || e}`);
      }
    }
  }
  s.status = v(s.registered.length === TOOLS.length,
               mc ? "tools registered on the top-level page" :
                 "no modelContext: open in the ChatGPT desktop app's built-in browser, or enable chrome://flags/#enable-webmcp-testing",
               !mc);
  report.sections.webmcp = s;
  render();
}

// ---------------------------------------------------------------- runner RPC
let rpc = null;
function connectRunner() {
  return new Promise((resolve, reject) => {
    const iframe = document.getElementById("runner");
    const timer = setTimeout(() => reject(new Error(`runner at ${RUNNER_ORIGIN} did not load in 15 s`)), 15000);
    const onLoaded = (e) => {
      if (e.origin !== RUNNER_ORIGIN || e.source !== iframe.contentWindow) return;
      if (e.data?.type !== "lc-runner-loaded") return;
      removeEventListener("message", onLoaded);
      const { port1, port2 } = new MessageChannel();
      const pending = new Map();
      let seq = 0;
      port1.onmessage = ({ data }) => {
        if (data.type === "ready") { clearTimeout(timer); resolve(call); return; }
        const p = pending.get(data.id);
        if (!p) return;
        pending.delete(data.id);
        data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
      };
      const call = (method, params = {}) => new Promise((res, rej) => {
        const id = ++seq;
        pending.set(id, { resolve: res, reject: rej });
        port1.postMessage({ id, method, params });
      });
      iframe.contentWindow.postMessage({ type: "lc-connect" }, RUNNER_ORIGIN, [port2]);
    };
    addEventListener("message", onLoaded);
    iframe.src = `${RUNNER_ORIGIN}/`;
  });
}

function summarise(raw) {
  const events = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { type: "log", message: l }; } });
  const tests = events.filter((e) => e.type === "test");
  const errors = events.filter((e) => e.type === "error" || e.type === "compile_error");
  return {
    total: tests.length,
    passed: tests.filter((t) => t.status === "pass").length,
    statuses: Object.fromEntries([...new Set(tests.map((t) => t.status))].map((s) => [s, tests.filter((t) => t.status === s).length])),
    firstFailure: tests.find((t) => t.status !== "pass")?.message?.split("\n").slice(-3).join("\n") ?? null,
    errors: errors.map((e) => String(e.message).slice(0, 400)),
  };
}

async function probeRunner() {
  try {
    if (!rpc) rpc = await connectRunner();
    const r = await rpc("probe");
    report.sections.runner = {
      connected: v(true, `MessageChannel RPC to ${r.origin}`),
      crossOriginIsolated: v(r.crossOriginIsolated, "needed for SharedArrayBuffer interrupts in the runner"),
      sharedArrayBuffer: r.sharedArrayBuffer,
      jspi: r.jspi,
      "own-origin IndexedDB (runtime cache)": r.indexedDB,
      "webgpu in page": r.webgpuInPage,
      "webgpu in runner worker": v(!!r.webgpuInWorker?.computeOk, r.webgpuInWorker, r.webgpuInWorker?.available),
    };
  } catch (e) {
    report.sections.runner = { connected: v(false, String(e.message || e)) };
  }
  render();
}

async function probePython() {
  if (!rpc) { report.sections.python = { skipped: v(false, "runner not connected") }; render(); return; }
  const s = {};
  report.sections.python = s;
  try {
    const info = await rpc("startPython");
    s["cold start"] = v(true, { startMs: Math.round(info.startMs), loadMs: Math.round(info.loadMs),
                                pyodide: info.version, reused: info.reused });
    s.facts = info.facts;
    s["interrupt buffer"] = v(info.interruptBuffer, info.interruptBuffer ? "SharedArrayBuffer wired" : "not isolated: terminate-only timeouts", true);
    render();

    const index = await (await fetch("./bundles/index.json")).json();
    for (const entry of index) {
      const bundle = await (await fetch(`./bundles/${entry.file}`)).json();
      const out = await rpc("runBundle", { bundle });
      const label = `${entry.problem_id} · ${entry.mode} (${entry.judge})`;
      if (out.timedOut || out.error) {
        s[label] = v(false, { timedOut: !!out.timedOut, stoppedBy: out.stoppedBy, error: out.error });
      } else {
        const sum = summarise(out.result.results);
        const expected = entry.expect === "all_pass"
          ? sum.total > 0 && sum.passed === sum.total && !sum.errors.length
          : sum.total > 0 && sum.passed < sum.total;
        s[label] = v(expected, {
          expect: entry.expect, ...sum, harnessError: out.result.harnessError?.split("\n").slice(-4).join("\n") ?? null,
          ms: { wall: Math.round(out.wallMs), packages: Math.round(out.result.pkgMs), harness: Math.round(out.result.harnessMs) },
        });
      }
      render();
    }
  } catch (e) {
    s.error = v(false, String(e.message || e));
  }
  render();
}

async function probeValidation() {
  if (!rpc) return;
  try {
    const ids = await (await fetch("./problems/index.json")).json();
    const problems = {};
    for (const id of ids) problems[id] = await (await fetch(`./problems/${id}.yaml`)).text();
    const modelsPy = await (await fetch("./core/models.py")).text();
    const out = await rpc("validateProblems", { problems, modelsPy });
    const s = { "load pydantic + pyyaml": `${Math.round(out.pkgMs)} ms`, "import models.py": `${Math.round(out.importMs)} ms` };
    for (const r of out.results) s[r.id] = v(r.ok, r.ok ? `${r.judge} · ${r.environment} · ${r.ms.toFixed(1)} ms` : r.error);
    report.sections.validation = s;
  } catch (e) {
    report.sections.validation = { error: v(false, String(e.message || e)) };
  }
  render();
}

async function probeTimeouts() {
  if (!rpc) return;
  try {
    // A 30 s busy loop with a 1.5 s budget: expect interrupt (isolated) or terminate + respawn.
    const out = await rpc("spin", { seconds: 30, budgetMs: 1500 });
    report.sections.timeouts = {
      "runaway loop stopped": v(out.timedOut === true, {
        stoppedBy: out.stoppedBy, stopMs: Math.round(out.stopMs ?? -1), wallMs: Math.round(out.wallMs),
        keyboardInterrupt: out.result?.keyboardInterrupt ?? null,
        respawnMs: out.respawnMs != null ? Math.round(out.respawnMs) : null,
      }),
      "clean interrupt (no respawn)": v(out.stoppedBy === "interrupt", out.stoppedBy === "interrupt"
        ? "interrupt buffer worked; warm interpreter kept" : "fell back to worker.terminate()", true),
    };
  } catch (e) {
    report.sections.timeouts = { error: v(false, String(e.message || e)) };
  }
  render();
}

let running = null;
async function runAll() {
  if (running) return running;
  running = (async () => {
    for (const k of ["app", "runner", "python", "validation", "timeouts"]) delete report.sections[k];
    render();
    await probeApp();
    await probeRunner();
    await probePython();
    await probeValidation();
    await probeTimeouts();
    report.generatedAt = new Date().toISOString();
    render();
  })();
  try { await running; } finally { running = null; }
}

document.getElementById("rerun").onclick = () => runAll();
document.getElementById("copy").onclick = async () => {
  await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
  document.getElementById("copy").textContent = "Copied";
  setTimeout(() => { document.getElementById("copy").textContent = "Copy report JSON"; }, 1500);
};

render();
registerTools();
runAll();
