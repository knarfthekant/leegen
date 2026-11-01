# AGENTS.md

leetclaude is a local, LeetCode-style programming trainer with **no fixed problem bank**. Agents
write problems as YAML files. The user solves them in a browser (description on the left, editor
and tests on the right) and runs tests on CPU or GPU executors. Agents also act as the user's
tutor through MCP: reading their code, running it, commenting on lines, and proposing edits.

This file is for any agent working in this repo. There are three jobs:

1. **Authoring**: create or improve problems. See [Authoring protocol](#authoring-protocol).
2. **Tutoring**: help the user with the problem they have open. See [Tutoring protocol](#tutoring-protocol).
3. **Developing**: change the app itself. See [Architecture](#architecture) and [Extending](#extending).

## Running

```bash
cd server && uv sync                      # backend deps (Python 3.13, uv)
cd web && npm install && npm run build    # frontend -> web/dist, served by the backend
cd server && uv run leetclaude serve      # http://127.0.0.1:8000 (UI) and /mcp (MCP)
```

Frontend development: `uv run leetclaude serve --reload` plus `cd web && npm run dev`
(http://localhost:5173, which proxies /api to :8000).

Connect an agent: `claude mcp add --transport http leetclaude http://127.0.0.1:8000/mcp`
(Codex and other clients use the same URL).

CLI, for agents without MCP. Run from `server/`:

| Command | What it does |
|---|---|
| `uv run leetclaude list` | List problems; invalid YAML files are reported |
| `uv run leetclaude validate --all` / `<id>` / `--file x.yaml` | Schema check + reference must pass every test + starter must fail |
| `uv run leetclaude run <id> [--reference] [--json]` | Run the user's workspace code (or the reference) |
| `uv run leetclaude schema` | Regenerate `schema/problem.schema.json` from the Pydantic models |

## Repo map

```
problems/<id>.yaml          problem bank (one self-contained file per problem)
problems/<id>/assets/       optional images referenced from the description
environments/<id>.yaml      runtimes: language, python version, dependencies, hardware needs
workspace/<id>/             the user's code (real files) + .leetclaude/*.json state (gitignored)
docs/authoring.md           full authoring guide (also served by the get_authoring_guide tool)
schema/problem.schema.json  generated JSON Schema for problem YAML
server/src/leetclaude/      FastAPI backend, runner, MCP server (Python package `leetclaude`)
web/src/                    React + Vite + Monaco frontend
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
   tolerances; GPU float32 needs `rtol≈1e-4`.
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
4. **Comment on code with `annotate`:** line ranges with severity `hint` / `warning` / `error`
   / `info` / `praise` and a short Markdown message. Use a general comment (no `file`) for
   overall feedback. Clear stale comments with `clear_annotations` once they no longer apply.
5. **Change code with `propose_edit`, never by writing files directly.** Suggestions appear as a
   diff the user accepts or rejects. Prefer small `edits` (exact search/replace) over replacing
   the whole file. (If something does write `workspace/<id>/...` directly, the app turns it into
   a suggestion anyway.)
6. Other tools: `add_test_case` adds an input to the user's Testcase panel (function judge);
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

- **Job bundle:** for each run, `runner/orchestrator.py` builds a temp dir containing:
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
  environment, never in the server process.
  - `function_judge.py`: generators, then the reference phase, then the user phase, then the
    optional benchmark. Reference and user code share module names; `module_scope()` isolates
    them.
  - `pytest_plugin.py`: turns pytest reports into result events and runs `async def` tests.
- **Executors** (`executors/`):
  - `local` runs a subprocess in a uv venv (`~/.cache/leetclaude/envs/<id>-<hash>`), with a
    timeout, a process group and CPU rlimits.
  - Capabilities (`cpu`, `mps`, `cuda`) are detected automatically. Problems and environments
    declare `requires`, and only compatible executors are offered.
  - Remote executors (`ssh`, `slurm`) are configured in `~/.config/leetclaude/executors.yaml`.
    See `docs/executors.md`. Never put credentials in that file; it relies on the user's own
    ssh setup.
- **State:**
  - `store/problems.py` reads and writes YAML.
  - `store/workspace.py` holds the user's files and JSON state.
  - `state.py` keeps the in-memory session the browser reports (unsaved buffers, cursor) and the
    WebSocket hub.
  - `watcher.py` pushes `problems/` changes to the UI and turns direct edits to workspace files
    into proposals.
- **MCP** (`mcp_server/server.py`) and the REST API (`api/routes.py`) share `services.py`,
  `tutor.py` and `validate.py`.

## Extending

- **New environment:** add `environments/<id>.yaml` (`language`, `python`, `dependencies`,
  `requires`, `env`, `env_without_cuda`). Provisioning is automatic on first run.
- **New language:** add `languages/<lang>.py` subclassing `LanguageAdapter`, decorate it with
  `@register("language", "<lang>")`, and import it in `languages/__init__.py`.
- **New judge kind:** add `judges/<kind>.py` (returns a `JudgePlan`: run.json config, command,
  build steps). Add a harness module if it runs in Python, and add the kind to the `Judge`
  model.
- **New executor:** subclass `Executor` (`capabilities`, `prepare`, `run`, `cancel`), register it
  with `@register("executor", "<kind>")`, and import it in `executors/__init__.py`. Executor
  config allows extra fields.
- **Schema changes:** edit `schema/models.py`, then run `uv run leetclaude schema`, and update
  `docs/authoring.md` and the seed problems.

## Conventions and checks

- Backend: `cd server && uv run pytest`. All seed problems must stay valid
  (`uv run leetclaude validate --all`).
- Frontend: `cd web && npm run typecheck && npm run build`. Browser smoke test against a running
  server: `node tests/smoke.mjs` (uses the installed Chrome through playwright-core).
- UI style is minimal: neutral greys, one accent colour, green/red only for pass/fail, 1px
  borders. No gradients, shadows or decorative colour.
- Problem content written by agents is untrusted input to the UI. The Markdown renderer
  sanitizes it (SVG allowed, scripts and event handlers stripped), so don't loosen
  `components/Markdown.tsx`'s schema without a reason.
