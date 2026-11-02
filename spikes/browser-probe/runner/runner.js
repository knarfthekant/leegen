// Runner origin: stateless execution host. It talks only to allow-listed parent origins over a
// MessageChannel and never touches the app's storage. Code runs in workers it owns.

import { probeWebGPUInWorker } from "./shared/gpu.js";

const statusEl = document.getElementById("status");
const setStatus = (s) => { statusEl.textContent = s; };

const config = await (await fetch("./config.json", { cache: "no-store" })).json();
const allowed = new Set(config.allowed_parents);

// ---------------------------------------------------------------- Python worker management
class PyWorker {
  constructor() {
    this.sab = globalThis.crossOriginIsolated ? new SharedArrayBuffer(1) : null;
    this.flag = this.sab ? new Uint8Array(this.sab) : null;
    this.pending = new Map();
    this.seq = 0;
    this.worker = null;
    this.info = null;
  }

  async start() {
    const t0 = performance.now();
    this.worker = new Worker(new URL("./py-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.error ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || "worker error"));
      this.pending.clear();
    };
    this.info = await this.call("init", {
      indexURL: new URL("./pyodide/", location.href).href,
      interruptBuffer: this.sab,
    });
    this.info.startMs = performance.now() - t0;
    return this.info;
  }

  call(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params });
    });
  }

  interrupt() {
    if (!this.flag) return false;
    this.flag[0] = 2;   // SIGINT -> KeyboardInterrupt at the next bytecode check
    return true;
  }

  kill() {
    this.worker?.terminate();
    for (const p of this.pending.values()) p.reject(new Error("worker terminated"));
    this.pending.clear();
    this.worker = null;
  }
}

let py = null;
async function ensurePython() {
  if (!py) {
    py = new PyWorker();
    try { await py.start(); } catch (e) { py.kill(); py = null; throw e; }
  }
  return py;
}

// Run a call with a wall-clock budget. Soft stop = interrupt buffer, hard stop = terminate.
async function withDeadline(worker, method, params, budgetMs) {
  if (worker.flag) worker.flag[0] = 0;
  let timer;
  const call = worker.call(method, params);
  const outcome = await Promise.race([
    call.then((result) => ({ result }), (error) => ({ error: String(error.message || error) })),
    new Promise((res) => { timer = setTimeout(() => res({ deadline: true }), budgetMs); }),
  ]);
  clearTimeout(timer);
  if (!outcome.deadline) return outcome;

  const t0 = performance.now();
  if (worker.interrupt()) {
    const soft = await Promise.race([
      call.then((result) => ({ result }), (error) => ({ error: String(error.message || error) })),
      new Promise((res) => setTimeout(() => res(null), 1500)),
    ]);
    if (soft) return { ...soft, timedOut: true, stoppedBy: "interrupt", stopMs: performance.now() - t0 };
  }
  worker.kill();
  py = null;
  return { timedOut: true, stoppedBy: "terminate", stopMs: performance.now() - t0 };
}

// ---------------------------------------------------------------- RPC
const methods = {
  async probe() {
    return {
      origin: location.origin,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      sharedArrayBuffer: typeof SharedArrayBuffer === "function",
      jspi: typeof WebAssembly !== "undefined" && "Suspending" in WebAssembly,
      webgpuInPage: "gpu" in navigator,
      indexedDB: await canOpenIndexedDB(),
      webgpuInWorker: await probeWebGPUInWorker(new URL("./shared/gpu-worker.js", import.meta.url)),
    };
  },

  async startPython() {
    const had = !!py;
    const w = await ensurePython();
    return { ...w.info, reused: had };
  },

  async runBundle({ bundle }) {
    const w = await ensurePython();
    const runCfg = JSON.parse(bundle.files["run.json"]);
    const budgetMs = (runCfg.timeout_s + 5) * 1000;
    const runId = Math.random().toString(36).slice(2, 10);
    const t0 = performance.now();
    const out = await withDeadline(w, "runBundle", {
      runId, files: bundle.files, judge: bundle.judge,
    }, budgetMs);
    return { ...out, wallMs: performance.now() - t0 };
  },

  async validateProblems({ problems, modelsPy }) {
    const w = await ensurePython();
    return w.call("validateProblems", { problems, modelsPy });
  },

  async spin({ seconds, budgetMs }) {
    const w = await ensurePython();
    const t0 = performance.now();
    const out = await withDeadline(w, "spin", { seconds }, budgetMs);
    out.wallMs = performance.now() - t0;
    if (out.stoppedBy === "terminate") {
      const r0 = performance.now();
      await ensurePython();
      out.respawnMs = performance.now() - r0;
    }
    return out;
  },
};

async function canOpenIndexedDB() {
  try {
    await new Promise((res, rej) => {
      const req = indexedDB.open("lc-runner-probe", 1);
      req.onsuccess = () => { req.result.close(); res(); };
      req.onerror = () => rej(req.error);
    });
    return true;
  } catch { return false; }
}

function serve(port) {
  port.onmessage = async ({ data }) => {
    const { id, method, params } = data || {};
    const fn = Object.hasOwn(methods, method) ? methods[method] : null;
    if (!fn) { port.postMessage({ id, error: `unknown method ${method}` }); return; }
    try {
      setStatus(`runner: ${method}…`);
      port.postMessage({ id, result: await fn(params || {}) });
    } catch (e) {
      port.postMessage({ id, error: String(e?.message || e) });
    } finally {
      setStatus("runner ready");
    }
  };
  port.postMessage({ type: "ready", origin: location.origin });
}

addEventListener("message", (e) => {
  if (!allowed.has(e.origin)) return;                    // ignore everyone but our app
  if (e.data?.type !== "lc-connect" || !e.ports?.[0]) return;
  serve(e.ports[0]);
});

// Tell the parent we're listening. postMessage with an explicit targetOrigin only delivers to
// a parent that actually has that origin.
for (const origin of allowed) window.parent.postMessage({ type: "lc-runner-loaded" }, origin);
setStatus("runner ready");
