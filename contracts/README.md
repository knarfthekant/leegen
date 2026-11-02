# contracts/

Shared between the server edition and the browser edition. Everything here except this README
is **generated** by `cd server && uv run leegen schema` from `server/src/leegen/core/`;
`uv run leegen schema --check` (and a backend test) fail when it is stale.

| File | What |
|---|---|
| `records.schema.json` | Wire records (`RunResult`, `TestResult`, `Annotation`, `Proposal`, `CustomTest`) and the `BackendEvent` union the UI listens to (WebSocket in the server, BroadcastChannel in the browser) |
| `inputs.schema.json` | Input shapes: `Problem`, `Environment`, and `RunnerRequest` (app origin → browser runner) |
| `tools.json` | Agent tools: names, descriptions and input schemas from the MCP server, plus WebMCP hints (`readOnlyHint`, `consequentialHint`, `untrustedContentHint`) from `core/toolspec.py`. The browser edition registers its WebMCP tools from this file, so both editions expose the same tools |
| `fixtures/*.json` | Golden cases produced by the Python core (review logic, views). The browser edition's TypeScript ports must reproduce them exactly (`cd web && npm test`) |

The TypeScript types for the same records live in `web/src/contracts/generated.ts` (also generated).

## Run protocol

Both editions run the same harness (`server/src/leegen/harness/`) on a bundle planned by
`core.plan.plan_run()`: `user/`, optional `ref/`, `_lc/leegen_harness/`, `run.json`. The
harness appends JSON lines (`test`, `metric`, `error`, `compile_error`, `log`) to
`$LEEGEN_RESULTS`, and `core.assemble.assemble()` turns them into a `RunResult`. The server
writes the bundle to a temp dir and runs it on an executor; the browser runner writes it to
Pyodide's in-memory filesystem and runs it in a worker, streaming lines as `RunnerEvent`s.
