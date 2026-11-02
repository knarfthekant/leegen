"""Assemble the two static sites (app origin + runner origin) for the browser probe.

    python3 -I spikes/browser-probe/tools/build_static.py \
        --app-origin http://localhost:13380 --runner-origin http://127.0.0.1:13381

Writes <out>/app and <out>/runner, each with a `_headers` file (Cloudflare Pages / Netlify
format) and a config.json naming the other origin. tools/serve.py applies the same `_headers`
locally, so local runs see exactly the deployed headers.

Requires vendor/pyodide (tools/fetch_pyodide.py). Exports job bundles with the server's planning
code through `uv run --project server`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

SPIKE = Path(__file__).resolve().parent.parent
REPO = SPIKE.parent.parent
BUNDLE_PROBLEMS = ["merge-ranges", "py-async-generators"]

APP_HEADERS = """\
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'; frame-src {runner}; object-src 'none'; base-uri 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
"""

RUNNER_HEADERS = """\
/*
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors {app}; object-src 'none'; base-uri 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
"""


def origin(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/"):
        raise SystemExit(f"not an origin: {value!r} (want scheme://host[:port])")
    return f"{parts.scheme}://{parts.netloc}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-origin", default="http://localhost:13380")
    ap.add_argument("--runner-origin", default="http://127.0.0.1:13381")
    ap.add_argument("--out", type=Path, default=SPIKE / "build")
    args = ap.parse_args()
    app_origin, runner_origin = origin(args.app_origin), origin(args.runner_origin)
    if app_origin == runner_origin:
        raise SystemExit("app and runner must be different origins")

    vendor = SPIKE / "vendor" / "pyodide"
    if not (vendor / "pyodide.mjs").is_file():
        raise SystemExit("vendor/pyodide is missing: run tools/fetch_pyodide.py first")

    out = args.out.resolve()
    if out.exists():
        shutil.rmtree(out)
    app, runner = out / "app", out / "runner"
    shutil.copytree(SPIKE / "app", app)
    shutil.copytree(SPIKE / "runner", runner)
    for site in (app, runner):
        shutil.copytree(SPIKE / "shared", site / "shared")
    shutil.copytree(vendor, runner / "pyodide")

    (app / "_headers").write_text(APP_HEADERS.format(runner=runner_origin))
    (runner / "_headers").write_text(RUNNER_HEADERS.format(app=app_origin))
    (app / "config.json").write_text(json.dumps({"runner_origin": runner_origin}))
    (runner / "config.json").write_text(json.dumps({"allowed_parents": [app_origin]}))

    # seed problems + the real schema module, for validation inside Pyodide
    (app / "problems").mkdir()
    ids = sorted(p.stem for p in (REPO / "problems").glob("*.yaml"))
    for pid in ids:
        shutil.copy(REPO / "problems" / f"{pid}.yaml", app / "problems" / f"{pid}.yaml")
    (app / "problems" / "index.json").write_text(json.dumps(ids))
    (app / "core").mkdir()
    shutil.copy(REPO / "server/src/leegen/core/models.py", app / "core" / "models.py")

    # job bundles exported by the server's own planning code
    subprocess.run(
        ["uv", "run", "--project", str(REPO / "server"), "python", "-I",
         str(SPIKE / "tools" / "export_bundles.py"), "--out", str(app / "bundles"),
         "--problems-dir", str(REPO / "problems"), *BUNDLE_PROBLEMS],
        check=True, cwd=REPO,
    )

    def size(p: Path) -> float:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6

    biggest = max((f for f in out.rglob("*") if f.is_file()), key=lambda f: f.stat().st_size)
    print(f"app    {app_origin:<28} {size(app):6.1f} MB  {app}")
    print(f"runner {runner_origin:<28} {size(runner):6.1f} MB  {runner}")
    print(f"largest file: {biggest.relative_to(out)} ({biggest.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
