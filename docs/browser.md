# Browser edition

The browser edition is leetclaude as a hosted static website. There is no server and nothing to
install: problems and the user's work live in the browser (IndexedDB), Python runs in the browser
(Pyodide, in a separate-origin runner), and agents work with the page through **WebMCP site
tools**. Codex's built-in browser discovers them automatically. The tools have the same names,
arguments and results as the server's MCP tools.

The server edition is unchanged: the two share `leetclaude.core` (the Python run planning,
assembly and validation, which the runner executes inside Pyodide), the generated contracts and
the web UI.

## Architecture

```
app origin (static)                                runner origin (static, stateless)
┌──────────────────────────────────────────┐       ┌────────────────────────────────────┐
│ web UI (vite build --mode browser)       │       │ runner.js: allow-listed            │
│ BrowserToolService (TS) ── IndexedDB     │ Msg-  │   MessageChannel RPC, deadlines    │
│ WebMCP tools (contracts/tools.json)      │ Chan- │ py-worker.js: Pyodide              │
│ EventHub (BroadcastChannel across tabs)  │ nel   │   leetclaude.core + browser_runner │
│ RunnerClient ── hidden iframe ───────────┼──────►│   + leetclaude_harness             │
└──────────────────────────────────────────┘       └────────────────────────────────────┘
```

- **App origin** (`web/src/backend/browser/`): `service.ts` mirrors the server's `ToolService`;
  `core.ts` ports `core/views.py` and `core/review.py` and is checked against
  `contracts/fixtures` (`npm test`); `tools.ts` registers the WebMCP tools; `db.ts` is the
  IndexedDB store; `transfer.ts` exports and imports zips.
- **Runner origin** (`web/runner/`): never sees app storage. Each request carries the problem
  YAML and the user's files. A run is `prepare` (core `plan_run`, bundle written to Pyodide's
  in-memory filesystem), `execute` (the unmodified harness) and `finish` (core `assemble` +
  `redact`). Those Python functions are in `server/src/leetclaude/browser_runner.py`, which the
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
uv run leetclaude browser build      # app -> web/dist-browser/app, runner -> web/dist-browser/runner
uv run leetclaude browser serve      # app http://localhost:13380, runner http://127.0.0.1:13381
cd ../web && node tests/browser-smoke.mjs   # headless check against the served build
```

`make browser` and `make browser-serve` do the same. The first build downloads Pyodide
(about 18 MB, checked against the npm sha512 and the lock file's sha256) into
`~/.cache/leetclaude/pyodide/`. `localhost` and `127.0.0.1` are different sites, so the local
setup has the same cross-origin layout as production.

## Deploy

Two static sites whose host applies `_headers` (Cloudflare Workers static assets, Cloudflare
Pages, Netlify). Build with the real origins, then deploy each directory:

```bash
cd server
uv run leetclaude browser build \
  --app-origin https://leetclaude.<you>.workers.dev \
  --runner-origin https://leetclaude-runner.<you>.workers.dev
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
`leetclaude_harness.webgpu`, through Pyodide's JavaScript bridge, on the GPU of the runner's worker.
The normal `function` judge compares the results. Compile and validation errors come back as
`kernel.wgsl:line:col` messages. GPU time from timestamp queries can be reported as a metric. A
kernel that never finishes is stopped by the same wall-clock deadline as runaway Python. The
seed track is `webgpu-101`: vector add, workgroup reduction, tiled matrix multiply. The server
edition lists these problems with a "browser edition" badge, and the browser edition marks
CUDA/PyTorch problems "server edition".

## Using it with Codex

Open the app URL in the ChatGPT desktop app's built-in browser. The status pill shows how many
agent tools are registered. Codex reads `document.modelContext` tools from the top-level page,
does not enforce input schemas (each tool checks its own input), and drops the tools when the
page navigates (the app routes with `pushState` only). The tools also work in Chrome with
`--enable-features=WebMCPTesting`, and the page exposes them as
`leetclaudeTools.call(name, input)` for scripts and tests.

## Storage, export and import

- Everything is in this browser's IndexedDB (`leetclaude` database). The app asks for persistent
  storage the first time work is saved. Without it, Safari may evict a site's data after seven
  days without a visit.
- **Export** (download icon on the problem list) writes a zip in the repo layout:
  `problems/<id>.yaml`, `problems/<id>/assets/…`, `workspace/<id>/<files>` and
  `workspace/<id>/.leetclaude/<state>.json`. Unzip it at the repo root and the local server sees
  the same problems and work.
- **Import** reads the same layout (also a zipped checkout with one top-level folder). Problems
  are schema-checked in the runner. Identical problems are skipped and changed ones replace the
  stored copy.
- **Folder sync** (Chromium, File System Access API): the folder icons save everything to a
  folder, or load from one, in the same layout. Pick your leetclaude checkout and the local
  server and the browser edition share `problems/` and `workspace/`. The folder is remembered
  (shift-click to choose another). Saving rewrites only files that changed and never touches
  anything outside `problems/` and `workspace/`. Sync is manual, not continuous.
- Shipped problems update with new builds unless the user changed or deleted them.

## Offline and multiple tabs

- Each origin has a service worker. The app caches its shell, data and the code chunks it has
  used, and the runner precaches Pyodide and its packages. After one online visit, the app opens
  and runs code offline. Hashed and versioned files are cached for good, and everything else is
  fetched network-first, so a new deploy takes effect on the next load.
- Tabs share one IndexedDB. Events (runs, annotations, proposals, problem changes) reach every
  tab through a BroadcastChannel. Runs of the same problem take a Web Lock, so two tabs never run
  it at once. Each tab has its own runner and its own editor session; an agent sees the tab
  whose tools it calls.

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
  Python host using `leetclaude_harness.webgpu`; see the authoring guide's archetypes). Other
  environments are saved unvalidated and cannot run here.
- Use the `function` or `pytest` judge. The `script` judge, subprocesses, threads and native
  extensions outside Pyodide's package set are unavailable.
- `create_problem` validates in the browser runner, with the same rules as the server. The tools
  return the same shapes as the server's MCP tools.
