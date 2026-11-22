# Browser edition

The browser edition is leegen as a hosted static website. There is no server and nothing to
install: problems and the user's work live in the browser (IndexedDB), Python runs in the browser
(Pyodide, in a separate-origin runner), and agents work with the page through **WebMCP site
tools**. Codex's built-in browser discovers them automatically. The tools have the same names,
arguments and results as the server's MCP tools.

Both editions share the problem YAML format, web UI, Python harness, generated contracts, and
`leegen.core` run planning, result assembly, and validation rules. The browser runner executes
the core in Pyodide; the server executes jobs through native local or remote executors. Both
expose corresponding agent tools, through WebMCP on the page or MCP over HTTP on the server.

| | Browser edition | Server edition |
| --- | --- | --- |
| Run code | Pyodide on the CPU; WGSL through WebGPU | Native local CPU/MPS/CUDA or remote SSH/Slurm |
| Environments | Python and WebGPU | Python, C++, PyTorch, Triton, CUDA |
| Judges | `function`, `pytest` | `function`, `pytest`, `script` |
| Agent | WebMCP in a supported browser | MCP over HTTP |
| Storage | IndexedDB for this browser and origin | Files in `data/problems/`, `data/tutorials/` and `data/workspace/` |

Open the [hosted browser edition](https://leegen.frankshan.workers.dev), or see the
[server quick start](../README.md#quick-start-server-edition). Use zip export/import to move
work between them; changes do not sync automatically.

## Architecture

```
app origin (static)                                runner origin (static, stateless)
┌──────────────────────────────────────────┐       ┌────────────────────────────────────┐
│ web UI (vite build --mode browser)       │       │ runner.js: allow-listed            │
│ BrowserToolService (TS) ── IndexedDB     │ Msg-  │   MessageChannel RPC, deadlines    │
│ WebMCP tools (contracts/tools.json)      │ Chan- │ py-worker.js: Pyodide              │
│ EventHub (BroadcastChannel across tabs)  │ nel   │   leegen.core + browser_runner     │
│ RunnerClient ── hidden iframe ───────────┼──────►│   + leegen_harness                 │
└──────────────────────────────────────────┘       └────────────────────────────────────┘
```

- **App origin** (`web/src/backend/browser/`): `service.ts` mirrors the server's `ToolService`;
  `core.ts` ports `core/views.py` and `core/review.py` and is checked against
  `contracts/fixtures` (`npm test`); `tools.ts` registers the WebMCP tools; `db.ts` is the
  IndexedDB store; `transfer.ts` exports and imports zips.
- **Runner origin** (`web/runner/`): never sees app storage. Each request carries the problem
  YAML and the user's files. A run is `prepare` (core `plan_run`, bundle written to Pyodide's
  in-memory filesystem), `execute` (the unmodified harness) and `finish` (core `assemble` +
  `redact`). Those Python functions are in `server/src/leegen/browser_runner.py`, which the
  server tests also run natively.
- **Isolation:** both origins send COOP/COEP, so the runner is cross-origin isolated and gets a
  SharedArrayBuffer interrupt buffer. Wall time is enforced from outside the interpreter: first
  `KeyboardInterrupt` at the next bytecode, then terminating the worker (a fresh one assembles the
  result). Cancel works the same way.
- **Validation** runs the server's rules (`core.validation`: precheck, reference passes, starter
  fails) in the runner, each run with its own deadline.

## Run it locally

```bash
cd server
uv run leegen browser build      # app -> web/dist-browser/app, runner -> web/dist-browser/runner
uv run leegen browser serve      # app http://localhost:13380, runner http://127.0.0.1:13381
cd ../web && node tests/browser-smoke.mjs   # headless check against the served build
```

`make browser` and `make browser-serve` do the same. The first build downloads Pyodide
(about 18 MB, checked against the npm sha512 and the lock file's sha256) into
`~/.cache/leegen/pyodide/`. `localhost` and `127.0.0.1` are different sites, so the local
setup has the same cross-origin layout as production.

## Deploy

Two static sites whose host applies `_headers` (Cloudflare Workers static assets, Cloudflare
Pages, Netlify). Build with the real origins, then deploy each directory:

```bash
cd server
uv run leegen browser build \
  --app-origin https://leegen.<you>.workers.dev \
  --runner-origin https://leegen-runner.<you>.workers.dev
cd ../web/dist-browser
npx wrangler deploy -c wrangler.app.jsonc
npx wrangler deploy -c wrangler.runner.jsonc
```

The origins are baked into `config.json` (the app's runner origin, the runner's allow-list) and
into the CSP (`frame-src`, `frame-ancestors`), so rebuild when they change. The largest file is
`pyodide.asm.wasm` (about 10 MB), which is under Cloudflare's 25 MiB per-file limit. Users download
about 20 MB the first time; after that it comes from the HTTP cache.

## WebGPU problems

The `webgpu` environment (`native: false`, `requires: [webgpu]`) runs only here. The user writes
a WGSL kernel (`kernel.wgsl`, highlighted in the editor). A hidden Python host dispatches it with
`leegen_harness.webgpu`, through Pyodide's JavaScript bridge, on the GPU of the runner's worker.
The normal `function` judge compares the results. Compile and validation errors come back as
`kernel.wgsl:line:col` messages. GPU time from timestamp queries can be reported as a metric. A
kernel that never finishes is stopped by the same wall-clock deadline as runaway Python. The
WebGPU signature example is `webgpu-tiled-matmul`, which covers workgroup memory, barriers,
boundary handling and GPU timing. The server edition lists it with a "browser edition" badge,
and the browser edition marks CUDA/PyTorch problems "server edition".

## Using it with Codex

Open the app URL in the ChatGPT desktop app's built-in browser. The status pill shows how many
agent tools are registered. Codex reads `document.modelContext` tools from the top-level page,
does not enforce input schemas (each tool checks its own input), and drops the tools when the
page navigates (the app routes with `pushState` only). The tools also work in Chrome with
`--enable-features=WebMCPTesting`, and the page exposes them as
`leegenTools.call(name, input)` for scripts and tests.

## Storage, export and import

- Everything is in this browser's IndexedDB (`leegen` database), scoped to the site's origin.
  There is no folder sync and nothing reads or writes your disk except the zip you export or
  import. Changing the domain or switching browsers does not move existing data automatically.
  The app asks for persistent storage the first time work is saved. Without it, Safari may evict
  a site's data after seven days without a visit.
- **Export** (download icon on the problem list) writes a zip in the data layout, the same tree
  as the local server's `data/` folder:

  ```
  problems/<id>.yaml            problems/<id>/assets/…
  tutorials/<id>.yaml
  workspace/<id>/<files>        workspace/<id>/.leegen/<state>.json
  workspace/tut-<id>/cells/<cell>.py    workspace/tut-<id>/.leegen/cell_results.json
  ```

  Unzip it into `data/` and the local server sees the same problems, tutorials and work.
- **Import** (upload icon) reads the same layout, found wherever it sits in the zip: the data
  folder itself, or a whole zipped checkout (its `data/`). Problems and tutorials are
  schema-checked in the runner. Identical ones are skipped and changed ones replace the stored
  copy. A workspace is imported only when its problem or tutorial exists. Tutorial references
  and checks are not re-run on import; run `leegen tutorial validate` on the server for that.
- Shipped problems and tutorials update with new builds unless the user changed or deleted them.

## Tutorials

The browser edition runs the same tutorials as the server (`data/tutorials/<id>.yaml`, guide in
[tutorials.md](tutorials.md)). They are bundled at build time (`leegen browser build` fails on
an invalid one), stored in IndexedDB's `tutorials` store, and added by importing a zip.

A cell run is a console snippet: `browser/tutorials.ts` sends the runner the earlier cells as
`prior`, the cell's code and its hidden `checks`, with the tutorial's stand-in problem
(`core.tutorial.shim_problem`, produced by the runner's `parse_tutorial`) as `problem_yaml`.
The learner's code and outcomes live in the workspace of `tut-<id>`, as on the server. The UI
only receives `publicTutorial()`, so checks and references stay out of the page's state.
Agents author and tutor through the same tutorial tools as on the server (`list_tutorials`,
`create_tutorial`, `run_tutorial_cell`, …); `create_tutorial` validates in the runner and saves to
IndexedDB. See [tutorials.md](tutorials.md#writing-a-tutorial-with-the-agent-tools).

## Offline and multiple tabs

- Each origin has a service worker. The app caches its shell, data and the code chunks it has
  used, and the runner precaches Pyodide and its packages. After one online visit, the app opens
  and runs code offline. Hashed and versioned files are cached for good, and everything else is
  fetched network-first, so a new deploy takes effect on the next load.
- Tabs share one IndexedDB. Events (runs, annotations, proposals, problem changes) reach every
  tab through a BroadcastChannel. Runs of the same problem take a Web Lock, so two tabs never run
  it at once. Each tab has its own runner and its own editor session; an agent sees the tab
  whose tools it calls.

## Console, run selection and editor intelligence

- The **Console** tab is a Jupyter-style scratchpad for Python-based environments. It runs in
  the same Pyodide runner as tests, with mode `snippet`: `prepare` writes the user's files plus
  the snippet, `execute` streams `output` events, and `finish` assembles a `ConsoleResult`.
  Output streamed before a hard timeout kill stays visible (the runner accumulates the lines).
- stdin is pre-seeded from the textarea. `input()` reads it line by line with no echo, and raises
  `EOFError` when it runs out.
- With a context file, the file is imported once (a `__main__` guard does not fire), then the
  snippet runs in that module's namespace, so it can call the file's functions and see its
  globals. Selections are dedented; the last expression is echoed unless the code ends with `;`.
  Top-level `await` is not supported.
- **Run selection** is `Ctrl/Cmd+Shift+Enter` in the editor (also in the context menu). It runs
  the selected text in the Console with the open file as context.
- Completions, parameter hints and hover come from an offline Python scanner
  (`web/src/lib/pythonSymbols.ts`, `pythonCatalog.ts`, `editorIntelligence.ts`), not a language
  server, and behave the same in both editions. Only Python files get them; WGSL and other
  languages keep Monaco's word-based suggestions.
- Console runs never touch `last_run` or the Test Result panel, and they share the per-problem
  run lock with tests, so the two never overlap.

## Limits

- Python plus WGSL only: environments with a `browser:` block (today `python` and `webgpu`).
  `pytorch`, `triton`, `cuda` and `cpp` problems are listed but run only on the server edition.
  The run panel says so. WebGPU needs a browser with an adapter (current Chrome, Edge or Safari;
  Firefox on Windows and Apple Silicon).
- Pyodide has no subprocesses, threads or signals: `function` and `pytest` judges only.
- Hidden tests and reference solutions are in the browser (the UI hides them, but anyone can
  read IndexedDB). This is a training tool, so that is accepted. Don't treat redaction as a
  security boundary here.
- WebMCP needs a browser that implements it (Codex's built-in browser today).
- Not built yet: running `webgpu` problems from the server edition by delegating to a browser
  runner (the plan's optional bridge). Use the browser edition for them.

## Notes for agents

You are in the **browser edition**. Problems and the user's code live in the user's browser, and
code runs there in Pyodide (Python 3.14) on the CPU.

- Use the `python` environment for CPU problems and `webgpu` for GPU kernels (WGSL with a hidden
  Python host using `leegen_harness.webgpu`; see the authoring guide's archetypes). Other
  environments are saved unvalidated and cannot run here.
- Use the `function` or `pytest` judge. The `script` judge, subprocesses, threads and native
  extensions outside Pyodide's package set are unavailable.
- `create_problem` validates in the browser runner, with the same rules as the server. The tools
  return the same shapes as the server's MCP tools.
- Tutorials work the same way: `create_tutorial` validates every reference and starter in the
  browser runner, and an environment without a `browser:` block is saved unvalidated. Read
  `get_tutorial_guide` before writing one.
