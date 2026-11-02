// Pyodide module worker for the leegen runner. One interpreter, reused across runs; the
// Python side (leegen.browser_runner) purges run modules before and after each run.
//
// Messages in:  {id, method, params}
// Messages out: {id, result} | {id, error} | {type: "line", line} (harness events, streamed)

let py = null;
let br = null;           // the leegen.browser_runner module
let output = [];         // interpreter-level stdout/stderr of the current run
const loaded = new Set();

// Only these browser_runner functions can be called, always with string arguments.
const PY_FUNCS = new Set([
  "prepare", "finish", "error_result", "read_results", "cleanup", "parse",
  "validate_precheck", "validate_after_reference", "validate_after_starter",
]);

async function callPy(fn, args) {
  if (!PY_FUNCS.has(fn) && fn !== "execute") throw new Error(`no python function ${fn}`);
  const names = args.map((_, i) => `_lc_a${i}`);
  args.forEach((a, i) => py.globals.set(names[i], a));
  try {
    return await py.runPythonAsync(`_lc_br.${fn}(${names.join(", ")})`);
  } finally {
    for (const n of names) py.globals.delete(n);
  }
}

const handlers = {
  async init({ indexURL, interruptBuffer, sourcesURL, preload }) {
    const t0 = performance.now();
    const { loadPyodide } = await import(new URL("pyodide.mjs", indexURL).href);
    py = await loadPyodide({
      indexURL,
      stdout: (s) => output.push(s),
      stderr: (s) => output.push(s),
    });
    if (interruptBuffer) py.setInterruptBuffer(new Uint8Array(interruptBuffer));
    const sources = await (await fetch(sourcesURL, { cache: "no-cache" })).json();
    for (const [rel, content] of Object.entries(sources)) {
      const path = `/lc/${rel}`;
      py.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
      py.FS.writeFile(path, content);
    }
    await loadPackages(preload || []);
    py.runPython("import sys\nsys.path.insert(0, '/lc')\nimport leegen.browser_runner as _lc_br");
    br = true;
    py.globals.set("_lc_sink", (line) => self.postMessage({ type: "line", line }));
    return { loadMs: performance.now() - t0, python: py.runPython("import sys; sys.version.split()[0]") };
  },

  loadPackages: ({ packages }) => loadPackages(packages || []),

  async call({ fn, args }) {
    if (fn === "prepare") output = [];
    return callPy(fn, args);
  },

  // Run the harness. Returns {crash, stdout, interrupted}.
  async execute({ base, device }) {
    output = [];
    py.globals.set("_lc_base", base);
    py.globals.set("_lc_device", device || "cpu");
    try {
      const crash = await py.runPythonAsync("_lc_br.execute(_lc_base, '/lc', _lc_sink, _lc_device)");
      return { crash: crash || "", stdout: output.join("\n"), interrupted: false };
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes("KeyboardInterrupt")) {
        return { crash: "", stdout: output.join("\n"), interrupted: true };
      }
      return { crash: msg, stdout: output.join("\n"), interrupted: false };
    }
  },
};

async function loadPackages(packages) {
  const todo = packages.filter((p) => !loaded.has(p));
  if (!todo.length) return [];
  await py.loadPackage(todo, { messageCallback: () => {}, errorCallback: (m) => output.push(m) });
  todo.forEach((p) => loaded.add(p));
  return todo;
}

// A soft stop raises KeyboardInterrupt in the running code; the `execute` handler reports it.
// asyncio's Task also re-raises BaseExceptions from its step callback, which would surface as
// a second, uncaught copy of the same interrupt: swallow only that.
const isInterrupt = (x) => /KeyboardInterrupt/.test(String(x?.message ?? x ?? ""));
self.addEventListener("unhandledrejection", (e) => {
  if (isInterrupt(e.reason)) e.preventDefault();
});
self.addEventListener("error", (e) => {
  if (isInterrupt(e.message) || isInterrupt(e.error)) e.preventDefault();
});

self.onmessage = async ({ data: { id, method, params } }) => {
  try {
    if (method !== "init" && !br) throw new Error("python is not initialised");
    const fn = Object.hasOwn(handlers, method) ? handlers[method] : null;
    if (!fn) throw new Error(`unknown method ${method}`);
    self.postMessage({ id, result: await fn(params || {}) });
  } catch (e) {
    self.postMessage({ id, error: String(e?.message || e) });
  }
};
