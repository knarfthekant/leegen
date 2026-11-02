// Pyodide module worker. Runs leegen job bundles with the unmodified harness, patched only
// where the browser can't do what native Python does (signal-based per-test alarms).

import { loadPyodide } from "./pyodide/pyodide.mjs";

let py = null;
let stdout = [];

const FACTS_PY = `
import json, sys, platform, signal, asyncio
facts = {"python": sys.version.split()[0], "platform": sys.platform,
         "machine": platform.machine(), "has_setitimer": hasattr(signal, "setitimer")}
try:
    signal.setitimer(signal.ITIMER_REAL, 0)
    facts["setitimer_call"] = "ok"
except Exception as exc:
    facts["setitimer_call"] = f"{type(exc).__name__}: {exc}"
try:
    from pyodide.ffi import can_run_sync
    facts["can_run_sync"] = bool(can_run_sync())
except Exception as exc:
    facts["can_run_sync"] = f"{type(exc).__name__}: {exc}"
facts["event_loop_policy"] = type(asyncio.get_event_loop_policy()).__name__
json.dumps(facts)
`;

// Runs the harness exactly like `python -m leegen_harness run.json`, from a per-run MEMFS dir.
const RUN_PY = `
import contextlib, os, sys

def _purge_run_modules():
    # user/ref/harness modules from earlier runs share names (solution, test_visible, ...)
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if f.startswith("/run/") or name == "leegen_harness" or name.startswith("leegen_harness."):
            del sys.modules[name]

base = LC_BASE
os.environ["LEEGEN_RESULTS"] = base + "/results.jsonl"
os.environ["LEEGEN_DEVICE"] = "cpu"
sys.dont_write_bytecode = True
_purge_run_modules()
lc_path = base + "/_lc"
sys.path.insert(0, lc_path)
cwd = os.getcwd()
try:
    from leegen_harness import _common

    @contextlib.contextmanager
    def _browser_alarm(seconds):
        # no SIGALRM in the browser: the runner enforces wall time (interrupt buffer / terminate)
        if seconds <= 0:
            raise _common.TestTimeout()
        yield

    if LC_PATCH_ALARM:
        _common.alarm = _browser_alarm
    sys.argv = ["leegen_harness", base + "/run.json"]
    from leegen_harness.__main__ import main
    main()
finally:
    os.chdir(cwd)
    if lc_path in sys.path:
        sys.path.remove(lc_path)
    _purge_run_modules()
`;

const VALIDATE_PY = `
import json, sys, time, yaml
sys.path.insert(0, "/lc_core")
from pydantic import ValidationError
import models
out = []
for pid, text in LC_PROBLEMS.items():
    t0 = time.perf_counter()
    try:
        p = models.Problem.model_validate(yaml.safe_load(text))
        out.append({"id": pid, "ok": True, "judge": p.judge.kind, "environment": p.environment,
                    "ms": (time.perf_counter() - t0) * 1000})
    except ValidationError as exc:
        out.append({"id": pid, "ok": False, "error": str(exc)[:500],
                    "ms": (time.perf_counter() - t0) * 1000})
json.dumps(out)
`;

const handlers = {
  async init({ indexURL, interruptBuffer }) {
    const t0 = performance.now();
    py = await loadPyodide({ indexURL, stdout: (s) => stdout.push(s), stderr: (s) => stdout.push(s) });
    if (interruptBuffer) py.setInterruptBuffer(new Uint8Array(interruptBuffer));
    const loadMs = performance.now() - t0;
    const facts = JSON.parse(py.runPython(FACTS_PY));
    return {
      loadMs, version: py.version, facts,
      interruptBuffer: !!interruptBuffer,
      jspi: typeof WebAssembly !== "undefined" && "Suspending" in WebAssembly,
    };
  },

  async runBundle({ runId, files, judge, patchAlarm = true }) {
    const base = `/run/${runId}`;
    const t0 = performance.now();
    let pkgMs = 0;
    if (judge === "pytest") {
      const p0 = performance.now();
      await py.loadPackage(["pytest"]);
      pkgMs = performance.now() - p0;
    }
    for (const [rel, content] of Object.entries(files)) {
      const path = `${base}/${rel}`;
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      py.FS.writeFile(path, content);
    }
    stdout = [];
    py.globals.set("LC_BASE", base);
    py.globals.set("LC_PATCH_ALARM", patchAlarm);
    const h0 = performance.now();
    let harnessError = null;
    try {
      await py.runPythonAsync(RUN_PY);
    } catch (e) {
      harnessError = String(e?.message || e);
    }
    const harnessMs = performance.now() - h0;
    let results = "";
    try { results = py.FS.readFile(`${base}/results.jsonl`, { encoding: "utf8" }); } catch { /* none */ }
    py.runPython(`import shutil; shutil.rmtree(${JSON.stringify(base)}, ignore_errors=True)`);
    return { results, stdout: stdout.join("\n"), harnessError, pkgMs, harnessMs,
             totalMs: performance.now() - t0 };
  },

  async validateProblems({ problems, modelsPy }) {
    const p0 = performance.now();
    await py.loadPackage(["pydantic", "pyyaml"]);
    const pkgMs = performance.now() - p0;
    py.FS.mkdirTree("/lc_core");
    py.FS.writeFile("/lc_core/models.py", modelsPy);
    const i0 = performance.now();
    py.runPython("import sys; sys.path.insert(0, '/lc_core'); import models");
    const importMs = performance.now() - i0;
    py.globals.set("LC_PROBLEMS", py.toPy(problems));
    const results = JSON.parse(py.runPython(VALIDATE_PY));
    return { pkgMs, importMs, results };
  },

  async spin({ seconds }) {
    const t0 = performance.now();
    try {
      py.runPython(`import time\nend = time.monotonic() + ${Number(seconds)}\nwhile time.monotonic() < end:\n    pass`);
      return { finished: true, ms: performance.now() - t0 };
    } catch (e) {
      const msg = String(e?.message || e);
      return { finished: false, keyboardInterrupt: msg.includes("KeyboardInterrupt"),
               ms: performance.now() - t0, error: msg.split("\n").slice(-2).join(" ") };
    }
  },
};

self.onmessage = async ({ data: { id, method, params } }) => {
  try {
    if (method !== "init" && !py) throw new Error("python not initialised");
    const fn = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (!fn) throw new Error(`unknown method ${method}`);
    self.postMessage({ id, result: await fn(params || {}) });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
