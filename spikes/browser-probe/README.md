# Browser edition: Phase 0 probe

This is a throwaway spike. It answers the questions the browser-edition plan needs settled before
Phase 1: can a hosted static page use WebMCP site tools, run the **unmodified** leetclaude harness
in Pyodide inside a **separate-origin runner**, stop runaway code, and reach WebGPU?

## Layout

| Path | What |
|---|---|
| `app/` | App origin: probe page, WebMCP tools (`probe_get_report`, `probe_rerun`, `probe_annotate`), runner RPC |
| `runner/` | Runner origin: allow-listed `MessageChannel` RPC, Pyodide module worker, deadline/interrupt logic |
| `shared/` | WebGPU compute probe, copied into both origins |
| `tools/fetch_pyodide.py` | Self-hosts Pyodide 314.0.7 plus pytest, pydantic and pyyaml into `vendor/`, verifying npm sha512 and lock-file sha256 |
| `tools/export_bundles.py` | Exports real job bundles with the server's own planning code (`_test_payload`, `judge.plan`, ...) |
| `tools/build_static.py` | Builds `build/app` and `build/runner`, each with a `_headers` file (Cloudflare Pages / Netlify format) and a `config.json` |
| `tools/serve.py` | Serves both sites locally and applies each site's `_headers`, so local runs see the same headers as a deploy |
| `tools/drive.mjs` | Headless check with the installed Chrome (playwright-core from `web/node_modules`) |

## Run locally

From the repo root:

```bash
python3 -I spikes/browser-probe/tools/fetch_pyodide.py --out spikes/browser-probe/vendor/pyodide
python3 -I spikes/browser-probe/tools/build_static.py          # app :13380, runner :13381
python3 -I spikes/browser-probe/tools/serve.py                 # Ctrl-C to stop
node spikes/browser-probe/tools/drive.mjs > /tmp/probe-report.json   # optional headless run
```

Open `http://localhost:13380/`. The runner is served as `http://127.0.0.1:13381`, which is a
different *site*, as it would be in production.

## Deploy (two static sites)

```bash
python3 -I spikes/browser-probe/tools/build_static.py \
  --app-origin https://<app-host> --runner-origin https://<runner-host> --out spikes/browser-probe/build-deploy
# then publish build-deploy/app and build-deploy/runner as two static sites whose host honours
# `_headers` (e.g. two Cloudflare Pages projects: `wrangler pages deploy build-deploy/app`).
```

Sizes: app 0.3 MB; runner 18.3 MB. The largest file is `pyodide.asm.wasm` at 9.6 MB.

## Results: headless Chrome 156, macOS (Apple Metal), 2026-11-01

| Question | Result |
|---|---|
| Cross-origin isolation on the app and in the cross-origin runner iframe | ✅ both `crossOriginIsolated`; SharedArrayBuffer is available in the runner |
| JSPI (`WebAssembly.Suspending`) | ✅ |
| WebGPU in the page, in an app worker, and in the **runner's worker** (cross-origin iframe) | ✅ compute kernel correct; `timestamp-query` available (GPU pass ≈ 0.1 ms) |
| Runner isolation | ✅ RPC only from the allow-listed origin; the runner has its own IndexedDB for caching runtimes |
| Pyodide cold start (self-hosted, 314.0.7 / Python 3.14.2) | ✅ ≈ 0.85–0.95 s with a warm HTTP cache (`Cache-Control: no-store` locally, so this is mostly instantiate/compile) |
| `merge-ranges` (function judge), reference / starter | ✅ 7/7 pass / 0/7 pass; ~90–175 ms per run |
| `py-async-generators` (pytest, `async def` tests), reference / starter | ✅ 11/11 pass / 1/11 pass; pytest load 122 ms the first time |
| Warm interpreter reused across 4 runs (same module names) | ✅ correct results; stale modules purged from `/run/*` |
| Harness changes needed | Only `_common.alarm`: `signal.setitimer` **does not exist** in Pyodide. `asyncio.run` worked under `runPythonAsync` |
| Runaway loop (30 s busy loop, 1.5 s budget) | ✅ stopped by the **interrupt buffer** in ~1 ms (`KeyboardInterrupt`); no respawn needed |
| All 7 seed problems through the real `schema/models.py` (pydantic) in Pyodide | ✅ import 247 ms once, then 4–9 ms per problem |
| WebMCP (`--enable-features=WebMCPTesting`) | ✅ `document.modelContext` present (`navigator.modelContext` absent). `registerTool`, `getTools` and `executeTool(tool, input)` round trip works; the result is serialised to a JSON string; in-`execute` validation rejects bad input |

## Deployed: Cloudflare Workers static assets, 2026-11-01

- App: https://leetclaude-probe.frankshan.workers.dev (Worker `leetclaude-probe`)
- Runner: https://leetclaude-probe-runner.frankshan.workers.dev (Worker `leetclaude-probe-runner`)
- Deployed with `npx wrangler deploy --name <worker> --assets <folder> --compatibility-date 2026-11-01`.
- `_headers` is honoured. COOP/COEP/CORP/CSP are served on HTML, JS and wasm, and the wasm is
  served as `application/wasm`. The 9.6 MB file is accepted.
- Asset-only Workers redirect `/index.html` to `/`, so the app loads the runner at `/`.
- Headless Chrome against the live URLs: every probe passes. The cold Pyodide start on a fresh
  profile, over the network, is ≈ 1.4 s.

## Codex built-in browser (ChatGPT desktop), 2026-11-01

- **Localhost:** Chrome 155. Every row passes. Codex discovered and called `probe_get_report`
  and `probe_annotate`.
- **Deployed site:** Chrome 156. Every row passes, and Codex called both tools again.
  - The runner is isolated on its own origin, and WebGPU works in its worker.
  - Cold Pyodide start ≈ 1.6 s.
  - The runaway loop was interrupted in 2 ms.

**Phase 0 verdict: go.** The plan holds as written: own static host, separate-origin runner,
real Python core in Pyodide, and WebGPU as a browser-only track.

## Remaining optional checks

- Safari and Firefox: open the deployed app URL, press **Copy report JSON** and keep the report.
