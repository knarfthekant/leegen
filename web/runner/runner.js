// leetclaude runner origin: a stateless execution host embedded by the app as a hidden iframe.
//
// - It talks only to allow-listed parent origins, over a MessageChannel the parent hands over.
// - It never sees the app's storage: every request carries what the run needs (problem YAML,
//   the user's files, custom tests), and the result goes back over the port.
// - Python runs in a module worker. Wall time is enforced from here: first the interrupt
//   buffer (KeyboardInterrupt at the next bytecode), then terminating the worker.
//
// Port protocol
//   app -> runner  {id, method, params}
//   runner -> app  {id, result} | {id, error}
//                  {type: "event", run_id, line}            harness result line (RunnerEvent)
//                  {type: "status", run_id, phase, detail}  loading / running

const statusEl = document.getElementById("status");
const setStatus = (s) => { statusEl.textContent = `leetclaude runner: ${s}`; };

const config = await (await fetch("./config.json", { cache: "no-cache" })).json();
const allowed = new Set(config.allowed_parents);
const STOP_GRACE_MS = 1500;     // interrupt -> terminate
const SLACK_MS = 3000;          // budget on top of the problem's timeout_s

// ---------------------------------------------------------------- the Python worker

class PyWorker {
  constructor() {
    this.sab = globalThis.crossOriginIsolated ? new SharedArrayBuffer(1) : null;
    this.flag = this.sab ? new Uint8Array(this.sab) : null;
    this.pending = new Map();
    this.seq = 0;
    this.onLine = null;
    this.worker = new Worker(new URL("./py-worker.js", import.meta.url), { type: "module" });
    this.worker.onmessage = ({ data }) => {
      if (data?.type === "line") { this.onLine?.(data.line); return; }
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      data.error !== undefined ? p.reject(new Error(data.error)) : p.resolve(data.result);
    };
    this.worker.onerror = (e) => {
      e.preventDefault?.();
      if (/KeyboardInterrupt/.test(e.message || "")) return;   // a stop we asked for
      this.failAll(new Error(e.message || "the Python worker crashed"));
    };
    this.ready = this.request("init", {
      indexURL: new URL(config.pyodide, location.href).href,
      sourcesURL: new URL("./lc-python.json", location.href).href,
      interruptBuffer: this.sab,
      preload: config.preload || [],
    });
  }

  request(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, params });
    });
  }

  py(fn, ...args) {
    return this.request("call", { fn, args });
  }

  interrupt() {
    if (!this.flag) return false;
    this.flag[0] = 2;   // SIGINT
    return true;
  }

  failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  kill() {
    this.worker.terminate();
    this.failAll(new Error("worker terminated"));
  }
}

let current = null;     // the warm worker, or null
let warmInfo = null;

async function worker(onStatus) {
  if (!current) {
    onStatus?.("loading", "Starting Python (Pyodide)…");
    current = new PyWorker();
    current.ready.then((info) => { warmInfo = info; }, () => {});
  }
  const w = current;
  try {
    await w.ready;
  } catch (e) {
    if (current === w) current = null;
    throw e;
  }
  return w;
}

function retire(w) {
  w.kill();
  if (current === w) current = null;
}

// ---------------------------------------------------------------- runs (one at a time)

let queue = Promise.resolve();
const serial = (fn) => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
};

const active = new Map();   // run_id -> {cancel()}
const early = new Map();    // run_id -> time: cancels that arrived before the run started

function takeEarlyCancel(runId) {
  const now = Date.now();
  for (const [id, t] of early) if (now - t > 120_000) early.delete(id);
  return early.delete(runId);
}

async function runOnce(req, notify) {
  const reqJson = JSON.stringify(req);
  const status = (phase, detail) => notify({ type: "status", run_id: req.run_id, phase, detail });
  const t0 = performance.now();
  let w = await worker(status);
  if (early.has(req.run_id)) {
    // cancelled while queued: nothing ran, so there is nothing to assemble but the cancel
    const prep = await w.py("prepare", reqJson, `/run/cancelled`);
    takeEarlyCancel(req.run_id);
    const facts = JSON.stringify({ exit_code: null, cancelled: true, duration_ms: performance.now() - t0 });
    const result = JSON.parse(await w.py("finish", reqJson, prep, "", facts));
    await w.py("cleanup", "/run/cancelled").catch(() => {});
    return result;
  }
  if (req.packages?.length) {
    status("loading", `Loading ${req.packages.join(", ")}…`);
    await w.request("loadPackages", { packages: req.packages });
  }
  const base = `/run/${req.run_id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  let prepared;
  try {
    prepared = await w.py("prepare", reqJson, base);
  } catch (e) {
    return JSON.parse(await w.py("error_result", reqJson, cleanError(e), String(performance.now() - t0)));
  }
  const { timeout_s } = JSON.parse(prepared);
  status("running", "Running tests");

  const lines = [];
  w.onLine = (line) => {
    lines.push(line);
    notify({ type: "event", run_id: req.run_id, line });
  };

  let stopReason = null;    // "timeout" | "cancel"
  let stopped;              // resolves when the run must stop
  const mustStop = new Promise((res) => { stopped = res; });
  const timer = setTimeout(() => { stopReason ??= "timeout"; stopped(); }, timeout_s * 1000 + SLACK_MS);
  active.set(req.run_id, { cancel() { stopReason ??= "cancel"; stopped(); } });
  if (takeEarlyCancel(req.run_id)) active.get(req.run_id).cancel();
  if (w.flag) w.flag[0] = 0;

  const exec = w.request("execute", { base, device: req.device || "cpu" })
    .then((r) => ({ r }), (error) => ({ error }));
  let outcome = await Promise.race([exec, mustStop.then(() => null)]);
  let killed = false;
  if (outcome === null) {
    // soft stop first, then the hard stop
    if (w.interrupt()) {
      outcome = await Promise.race([exec, sleep(STOP_GRACE_MS).then(() => null)]);
    }
    if (outcome === null) {
      retire(w);
      killed = true;
      outcome = { r: { crash: "", stdout: "", interrupted: true } };
    }
  }
  clearTimeout(timer);
  active.delete(req.run_id);
  w.onLine = null;

  const r = outcome.r ?? { crash: cleanError(outcome.error), stdout: "", interrupted: false };
  const duration = performance.now() - t0;
  const facts = JSON.stringify({
    exit_code: r.crash ? 1 : (stopReason ? null : 0),
    stdout: r.stdout || "",
    stderr: r.crash || (killed ? `stopped: the run exceeded its ${timeout_s}s limit and the Python worker was restarted` : ""),
    timed_out: stopReason === "timeout",
    cancelled: stopReason === "cancel",
    duration_ms: duration,
  });
  if (killed || !current) w = await worker(status);   // fresh interpreter to assemble the result
  const result = JSON.parse(await w.py("finish", reqJson, prepared, lines.join("\n"), facts));
  if (!killed) await w.py("cleanup", base).catch(() => {});
  return result;
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const cleanError = (e) => String(e?.message || e).replace(/^PythonError:\s*/, "").trim();

// ---------------------------------------------------------------- RPC methods

const methods = {
  async hello() {
    return {
      origin: location.origin,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      webgpu: await hasWebGPU(),
      version: config.version,
      python: warmInfo?.python ?? null,
    };
  },

  async warm() {
    const w = await worker();
    return { ...warmInfo, ready: !!w };
  },

  run({ request }, notify) {
    return serial(() => runOnce(request, notify));
  },

  async cancel({ run_id }) {
    const run = active.get(run_id);
    if (run) run.cancel();
    else early.set(run_id, Date.now());   // not started yet (loading or queued)
    return { cancelled: true };
  },

  async parse({ problem_yaml }) {
    const w = await worker();
    return JSON.parse(await w.py("parse", problem_yaml));
  },

  // The server's validation rules (leetclaude.core.validation), one deadline per run.
  validate({ problem_yaml, environments, capabilities, packages, run_id }, notify) {
    return serial(async () => {
      const w = await worker();
      const pre = JSON.parse(await w.py("validate_precheck", problem_yaml,
        JSON.stringify(environments), JSON.stringify(capabilities)));
      if (pre.done) return pre.done;
      const base = { problem_yaml, packages: packages || [], device: pre.device };
      const id = run_id || Math.random().toString(36).slice(2, 10);
      const ref = await runOnce({ ...base, run_id: `${id}-reference`, mode: "reference" }, notify);
      const w2 = await worker();
      const after = JSON.parse(await w2.py("validate_after_reference", problem_yaml, JSON.stringify(ref)));
      if (after.done) return after.done;
      const starter = await runOnce({ ...base, run_id: `${id}-starter`, mode: "user" }, notify);
      const w3 = await worker();
      return JSON.parse(await w3.py("validate_after_starter", problem_yaml,
        JSON.stringify(ref), JSON.stringify(starter)));
    });
  },
};

let gpuProbe = null;
function hasWebGPU() {
  gpuProbe ??= (async () => {
    try {
      return !!(await navigator.gpu?.requestAdapter());
    } catch {
      return false;
    }
  })();
  return gpuProbe;
}

// ---------------------------------------------------------------- connection

function serve(port) {
  const notify = (msg) => port.postMessage(msg);
  port.onmessage = async ({ data }) => {
    const { id, method, params } = data || {};
    const fn = Object.hasOwn(methods, method) ? methods[method] : null;
    if (!fn) { port.postMessage({ id, error: `unknown method ${method}` }); return; }
    try {
      setStatus(`${method}…`);
      port.postMessage({ id, result: await fn(params || {}, notify) });
    } catch (e) {
      port.postMessage({ id, error: cleanError(e) });
    } finally {
      setStatus("ready");

// offline + fast restarts: cache Pyodide (a partitioned worker when embedded cross-site)
navigator.serviceWorker?.register("./sw.js").catch(() => {});
    }
  };
  port.postMessage({ type: "ready", origin: location.origin });
}

addEventListener("message", (e) => {
  if (!allowed.has(e.origin)) return;                  // only our app may connect
  if (e.data?.type !== "lc-connect" || !e.ports?.[0]) return;
  serve(e.ports[0]);
});

// tell the parent we're listening (an explicit targetOrigin only reaches a matching parent)
if (window.parent !== window) {
  for (const origin of allowed) window.parent.postMessage({ type: "lc-runner-loaded" }, origin);
}
setStatus("ready");

// offline + fast restarts: cache Pyodide (a partitioned worker when embedded cross-site)
navigator.serviceWorker?.register("./sw.js").catch(() => {});
