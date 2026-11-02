# AGENTS.md

leetclaude is a local, LeetCode-style programming trainer with **no fixed problem bank**. Agents
write problems as YAML files. The user solves them in a browser (description on the left, editor
and tests on the right) and runs tests on CPU or GPU executors. Agents also act as the user's
tutor through MCP: reading their code, running it, commenting on lines, and proposing edits.

There are two editions. The **server edition** (this repo running locally) uses MCP and native,
SSH and SLURM executors. The **browser edition** is a static site: IndexedDB for storage,
Python in a separate-origin Pyodide runner, and WebMCP site tools for agents (Codex's built-in
browser). The tools have the same names and results in both. See [Browser edition](#browser-edition)
and `docs/browser.md`.

This file is for any agent working in this repo. There are three jobs:

1. **Authoring**: create or improve problems. See [Authoring protocol](#authoring-protocol).
2. **Tutoring**: help the user with the problem they have open. See [Tutoring protocol](#tutoring-protocol).
3. **Developing**: change the app itself. See [Architecture](#architecture) and [Extending](#extending).

## Running

```bash
make start    # installs deps if missing, rebuilds the UI if stale, serves UI + API + MCP
make dev      # backend with --reload + Vite hot reload, together; Ctrl-C stops both
make stop     # stop the server started by start/dev, from any terminal (make restart = stop + start)
```

| Port | What | Override |
|---|---|---|
| 13370 | UI, REST API, WebSocket and MCP (`/mcp`), all served by the backend | `LEETCLAUDE_PORT` (or `--port`) |
| 13371 | Vite dev server (`make dev` only); proxies `/api` and `/mcp` to 13370 | `LEETCLAUDE_WEB_PORT` |

Without make, from `server/`: `uv run leetclaude start` (`--no-build` skips the UI build),
`uv run leetclaude dev` and `uv run leetclaude stop [--port N]`. `uv run leetclaude serve` serves
without building. If a port is taken, startup fails with a message naming the variable to change;
ports never drift silently.

`stop` is PID-exact: launchers record their PID in `~/.cache/leetclaude/run/server-<port>.json`,
and `stop` signals only that process (SIGTERM, then SIGKILL after `--timeout`) after checking that
its command line is a leetclaude entry point. Without a pidfile it falls back to the leetclaude
process listening on the port. Any other program on the port is reported and never touched.

Connect an agent: the repo's `.mcp.json` registers `http://127.0.0.1:13370/mcp` for Claude Code
automatically. Elsewhere: `claude mcp add --transport http leetclaude http://127.0.0.1:13370/mcp`
(Codex and other clients use the same URL).

CLI, for agents without MCP. Run from `server/`:

| Command | What it does |
|---|---|
| `uv run leetclaude start` / `dev` / `stop` / `serve` | Launch or stop the server (see [Running](#running)) |
| `uv run leetclaude list` | List problems; invalid YAML files are reported |
| `uv run leetclaude validate --all` / `<id>` / `--file x.yaml` | Schema check + reference must pass every test + starter must fail |
| `uv run leetclaude run <id> [--reference] [--json]` | Run the user's workspace code (or the reference) |
| `uv run leetclaude schema` | Regenerate `schema/problem.schema.json` from the Pydantic models |
| `uv run leetclaude browser build` / `serve` | Build the browser edition's two static sites / serve them locally with their headers |

## Repo map

```
problems/<id>.yaml          problem bank (one self-contained file per problem)
problems/<id>/assets/       optional images referenced from the description
environments/<id>.yaml      runtimes: language, python version, dependencies, hardware needs
workspace/<id>/             the user's code (real files) + .leetclaude/*.json state (gitignored)
docs/authoring.md           full authoring guide (also served by the get_authoring_guide tool)
docs/browser.md             the browser edition: architecture, build, deploy, limits
docs/executors.md           executor kinds and executors.yaml
docs/clusters/README.md     shared guide for setting up remote cluster backends
docs/clusters/<name>.md     local per-cluster notes (gitignored)
schema/problem.schema.json  generated JSON Schema for problem YAML
contracts/                  generated: records/events schemas, tool manifest, conformance fixtures
server/src/leetclaude/      FastAPI backend, runner, MCP server (Python package `leetclaude`)
server/src/leetclaude/core/ pure core shared with the browser runner (stdlib + pydantic only)
web/src/                    React + Vite + Monaco frontend (primitives in components/ui.tsx)
web/src/backend/            Backend interface: server.ts (REST/WS) and browser/ (IndexedDB, WebMCP)
web/runner/                 browser edition's runner origin (Pyodide worker, deadlines, RPC)
server/src/leetclaude/browser_runner.py   what the Pyodide worker calls (prepare/execute/finish)
server/src/leetclaude/browser_edition/    browser build: Pyodide fetch, data bundle, _headers
```

## Authoring protocol

Read `docs/authoring.md` (or call `get_authoring_guide`) before writing your first problem.
Short version:

1. **Pick the environment and hardware.** `list_environments` shows what exists and which
   executors can run each one. CPU Python is `python`. PyTorch on any GPU is `pytorch` with
   `requires: [gpu]`. Use `requires: [cuda]` only for problems that need NVIDIA (raw CUDA,
   real Triton).
2. **Pick the judge kind:**

   | Problem shape | Judge |
   |---|---|
   | Pure function, input to output (algorithms, tensor ops) | `function` |
   | Class driven by a sequence of method calls | `function` with `calls` |
   | Async code, stateful objects, several files, error behaviour | `pytest` |
   | Non-Python harness (CUDA/C++ binary), custom benchmarks | `script` |

3. **Write the files.** `editable` holds starter code (signatures, docstrings, `TODO`s, no
   solution). `readonly` holds context the user reads (helper modules, `test_visible.py`).
   `hidden` holds setup, input generators, hidden tests and custom comparators.
4. **Always include `reference`**, a correct solution for the editable files. Validation runs it,
   and the expected values of `expected: from_reference` and user-added tests come from it.
5. **Tests:** 2–3 visible tests that mirror the examples in the description, then hidden tests
   for edge cases (empty input, boundaries, duplicates, large or random inputs, error paths).
   Seed all randomness. For floats and tensors use `float` or `allclose` with explicit
   tolerances; GPU float32 needs `rtol≈1e-4`. The UI shows cases as `Test 1..N` with only their
   `description`, so give every test a one-line `description`. Group related tests with
   top-level `sections` (`id`, `title`, `description`) and `section: <id>` on each test (see the
   authoring guide). pytest problems group by test class automatically.
6. **Description:** Markdown with KaTeX math, `mermaid` code fences, inline `<svg>` figures and
   `:::note` / `:::warning` / `:::details{summary="..."}` / `:::figure{caption="..."}` blocks.
   No raw HTML other than SVG, and no scripts. State the exact function signature, input/output
   format and constraints, plus at least one worked example.
7. **Validate, then save:** `validate_problem_yaml` returns a report. Fix every issue, then call
   `create_problem` (or `update_problem`). It saves only if the reference passes every test and
   the starter fails at least one. Without MCP, write `problems/<id>.yaml` and run
   `uv run leetclaude validate <id>`.
8. `id` is a lowercase slug and must equal the file name. Use `track` + `order` for multi-part
   curricula (for example `cuda-101`, orders 1..N).

Good examples to copy from: `merge-ranges` (function + generator), `py-async-generators`
(pytest, learning-style), `rate-limiter-service` (half-built multi-file app), `kv-cache-basics`
(PyTorch on GPU, tensor generators, allclose), `triton-vector-add` (Triton, NVIDIA),
`cuda-vector-add` (script judge with a hidden CUDA harness using `<leetclaude/judge.h>`).

## Tutoring protocol

When the user asks for help with the problem they have open:

1. **Call `get_session` first.** It returns the open problem, the user's *current* code
   (including unsaved edits), their cursor and selection, the last run's failing tests, existing
   comments and pending suggestions.
2. **Diagnose from evidence.** Read the failing tests' input, expected and actual values and the
   message. Use `run_tests` to check a hypothesis on their current code. `get_problem` with
   `include_hidden=true` shows the reference and hidden tests. Use them to understand the
   problem; don't paste them to the user.
3. **Hints go in small steps.** Point at the concept first, then the location, then the fix.
   Don't write the whole solution unless the user explicitly asks for it. This is a training
   tool.
4. **Comment on code with `annotate`:** line ranges, or exact character ranges, with severity
   `hint` / `warning` / `error` / `info` / `praise` and a short Markdown message. Add
   `start_col` / `end_col` (1-based, `end_col` exclusive) to mark exactly the offending token or
   expression; without columns the text of the line(s) is marked, minus indentation. Comments
   may overlap and each stays visible. In the editor a comment is a highlight plus one gutter
   dot (a bar for several lines); the user hovers it to peek and clicks it to focus it in the
   Review tab (click again or press Esc to unfocus). Use a general comment (no `file`) for
   overall feedback. Clear stale comments with `clear_annotations` once they no longer apply.
5. **Change code with `propose_edit`, never by writing files directly.** Suggestions appear as a
   diff the user accepts or rejects. Prefer small `edits` (exact search/replace) over replacing
   the whole file. (If something does write `workspace/<id>/...` directly, the app turns it into
   a suggestion anyway.)
6. Other tools: `add_test_case` adds an input to the user's Testcase panel (function judge; it
   is named `Test <n>` and can take a `description` and a `section`);
   `open_problem` moves the browser to a problem.
7. For a code review: do correctness first (point at failing cases), then complexity, then
   style. Praise what is good.

## Architecture

The layers are decoupled. Each one is an interface plus a registry
(`server/src/leetclaude/registry.py`).

```
Problem YAML ─► Judge kind ─► Language adapter ─► Environment ─► Executor
(what)          (how tested)  (how built/run)     (deps/runtime) (where it runs)
```

- **Core** (`server/src/leetclaude/core/`): the schema models, run planning (`plan.py`), result
  assembly (`assemble.py`), views, review logic (annotations, edits, proposals), validation rules
  and the tool spec. It is pure (stdlib + pydantic, pyyaml in `parse.py`) because the browser
  edition's runner imports the same modules inside Pyodide. Never add I/O or server imports here.
- **Job bundle:** for each run, `runner/orchestrator.py` writes `core.plan.plan_run()`'s plan to a
  temp dir containing:
  - `user/`: the user's files, readonly files and hidden files
  - `ref/`: the same, with the reference solution swapped in (only when needed)
  - `_lc/leetclaude_harness/`: the harness library
  - `run.json`
- **Results protocol:** the harness appends JSON lines to `$LEETCLAUDE_RESULTS`:
  - `{"type": "test", "name", "status": "pass|fail|error|timeout|skipped", "visible", "input", "expected", "actual", "message", "stdout", "duration_ms"}`
  - `{"type": "metric", "name", "value", "unit", "reference"}`
  - `{"type": "error"|"compile_error"|"log", "message"}`

  Every judge kind and language uses this format. Non-Python harnesses only need to print these
  lines.
- **Harness** (`server/src/leetclaude/harness/leetclaude_harness/`): standard library only (plus
  pytest for the pytest judge). It is copied into every bundle and runs inside the problem's
  environment, never in the server process. It also runs unmodified in Pyodide: `alarm()` falls
  back to deadline checks where `signal.setitimer` is missing, `run_coro()` handles Pyodide's
  running event loop, and `protocol.set_sink()` streams events.
  - `function_judge.py`: generators, then the reference phase, then the user phase, then the
    optional benchmark. Reference and user code share module names; `module_scope()` isolates
    them.
  - `pytest_plugin.py`: turns pytest reports into result events and runs `async def` tests.
- **Executors** (`executors/`):
  - `local` runs a subprocess in a uv venv (`~/.cache/leetclaude/envs/<id>-<hash>`), with a
    timeout, a process group and CPU rlimits.
  - Capabilities (`cpu`, `mps`, `cuda`) are detected automatically. Problems and environments
    declare `requires`, and only compatible executors are offered. Executors also have a
    `runtime` (`native` here, `pyodide` for the browser runner); environments list theirs
    (`native: true`, plus a `browser:` block if they run in the browser). See `core/compat.py`.
  - Remote executors (`ssh`, `slurm`) are configured in `~/.config/leetclaude/executors.yaml`.
    See `docs/executors.md`. Never put credentials in that file; it relies on the user's own
    ssh setup.
  - **Setting up a new remote cluster:** don't copy another cluster's config or pin packages.
    Probe the cluster (mounts, `noexec`, modules, driver/CUDA version, uv, PyPI access), write
    its executor entry, and record the findings in the gitignored `docs/clusters/<name>.md`.
    Follow the shared setup guide in `docs/clusters/README.md`.
- **State:**
  - `store/problems.py` reads and writes YAML.
  - `store/workspace.py` holds the user's files and JSON state.
  - `state.py` keeps the in-memory session the browser reports (unsaved buffers, cursor) and the
    WebSocket hub.
  - `watcher.py` pushes `problems/` changes to the UI and turns direct edits to workspace files
    into proposals.
- **ToolService** (`service.py`) holds every operation the UI and agents perform, with its stores,
  session, event sink and orchestrator injected (wired in `state.py`). MCP (`mcp_server/server.py`)
  and REST (`api/routes.py`) are thin adapters over it: put new behaviour in the service, then
  expose it in both. `services.py`, `tutor.py` and `validate.py` are compatibility wrappers.
- **Contracts** (`contracts/`, generated by `uv run leetclaude schema` from `core/`): record and
  event schemas, `tools.json` (MCP tool definitions + `core/toolspec.py` hints, which the browser
  edition registers as WebMCP tools), conformance fixtures, and `web/src/contracts/generated.ts`.
  `uv run leetclaude schema --check` fails when they are stale; a test enforces it.

### Browser edition

- **Same core, different shell.** The UI talks to a `Backend` (`web/src/backend/types.ts`). The
  build picks one: `vite build` gives `server.ts`, and `vite build --mode browser` (what
  `leetclaude browser build` runs) gives `browser/`.
- **App origin:** `browser/service.ts` is `BrowserToolService`, the TS twin of `ToolService`.
  `browser/core.ts` ports `core/views.py` and `core/review.py`, and `npm test` checks it against
  `contracts/fixtures`. `browser/tools.ts` registers every tool in `contracts/tools.json` with
  `document.modelContext` and validates inputs itself. Storage is `browser/db.ts` (IndexedDB) and
  cross-tab events are `browser/events.ts` (BroadcastChannel). `browser/transfer.ts` exports and
  imports zips in the repo layout, and `browser/folder.ts` saves to and loads from a folder
  (File System Access). Service workers (`web/sw/app-sw.js`, `web/runner/sw.js`; the build fills
  in their precache lists) make both origins work offline.
- **Runner origin** (`web/runner/`): stateless and allow-listed. It runs `browser_runner.py`
  (core `plan_run` → harness → core `assemble`) in Pyodide. Validation follows the
  `core.validation` steps (`precheck`, `after_reference`, `after_starter`), with a deadline per
  run. Timeouts and cancels use the interrupt buffer first, then terminate the worker.
- **Rules:**
  - Behaviour that both editions need goes into `leetclaude.core` (Python, which Pyodide runs) or
    into the service on both sides.
  - Any change to `core/views.py` or `core/review.py` must be mirrored in `browser/core.ts`, then
    run `uv run leetclaude schema` and `npm test`.
  - An environment runs in the browser only if it has a `browser:` block (Pyodide packages).

## Extending

- **New environment:** add `environments/<id>.yaml` (`language`, `python`, `dependencies`,
  `requires`, `env`, `env_without_cuda`). Provisioning is automatic on first run. Add
  `browser: {packages: [...]}` (Pyodide packages) if it can run in the browser edition, and
  `native: false` if it can't run natively.
- **New language:** add `languages/<lang>.py` subclassing `LanguageAdapter`, decorate it with
  `@register("language", "<lang>")`, and import it in `languages/__init__.py`.
- **New judge kind:** add `judges/<kind>.py` (returns a `JudgePlan`: run.json config, command,
  build steps). Add a harness module if it runs in Python, and add the kind to the `Judge`
  model.
- **New executor:** subclass `Executor` (`capabilities`, `prepare`, `run`, `cancel`), register it
  with `@register("executor", "<kind>")`, and import it in `executors/__init__.py`. Executor
  config allows extra fields.
- **Schema changes:** edit `core/models.py`, then run `uv run leetclaude schema`, and update
  `docs/authoring.md` and the seed problems.
- **New agent tool:** add the operation to `ToolService`, an MCP tool in `mcp_server/server.py`
  (its docstring is the description), an entry in `core/toolspec.py`, then regenerate contracts and
  add the browser implementation (`web/src/backend/browser/`).

## Conventions and checks

- Backend: `cd server && uv run pytest`. All seed problems must stay valid
  (`uv run leetclaude validate --all`).
- Frontend: `cd web && npm test && npm run typecheck && npm run build`. Browser smoke test against
  a running server: `make smoke` / `node tests/smoke.mjs` (uses the installed Chrome through
  playwright-core). `make check` runs the backend tests, problem validation, the TS conformance
  tests and the frontend build.
- Browser edition: `make browser && make browser-serve`, then `make browser-smoke` (fresh Chrome
  profile; validates the python seeds in Pyodide, then runs, times out, cancels, uses the tools,
  reloads, and does an export/import round trip).
- UI style: minimal, tonal surfaces. Rounded cards (`--r-*` tokens) sit on a soft canvas and
  sections are separated by shade, not borders (at most a low-alpha `--line` hairline). One
  accent colour; pass/warn/fail appear only as faded tints (`.tone-*` classes). lucide-react
  icons in tabs and toolbars; 150–250ms eased transitions; respect `prefers-reduced-motion`.
  No gradients or decorative colour; a soft shadow only on overlays (the problem drawer).
  Both light and dark themes must work (`[data-theme]` on `<html>`, toggle in the top bar).
  Reuse the primitives in `web/src/components/ui.tsx` instead of new one-off styles.
- Problem content written by agents is untrusted input to the UI. The Markdown renderer
  sanitizes it (SVG allowed, scripts and event handlers stripped), so don't loosen
  `components/Markdown.tsx`'s schema without a reason.
