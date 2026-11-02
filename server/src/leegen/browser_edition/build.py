"""Build the browser edition: two static sites, the app origin and the runner origin.

    uv run leegen browser build --app-origin https://app.example --runner-origin https://run.example

<out>/app      the web UI built with `vite build --mode browser`, plus data/ (seed problems,
               environments, guides, tool manifest) and assets
<out>/runner   the stateless runner page, Pyodide, and the Python it loads (leegen.core,
               the browser runner glue and the harness)

Each site gets a `_headers` file (Cloudflare / Netlify format) with COOP/COEP/CSP, and a
`wrangler.<site>.jsonc` sits next to them for `npx wrangler deploy -c ...`.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit

from leegen.config import settings
from leegen.core.toolspec import TUTORING_GUIDE

from . import pyodide

PKG = Path(__file__).resolve().parent.parent          # server/src/leegen
HARNESS = PKG / "harness" / "leegen_harness"
CORE_PACKAGES = ["pydantic", "pyyaml"]                 # what leegen.core itself imports

APP_HEADERS = """\
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src {runner}; object-src 'none'; base-uri 'none'; form-action 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
"""

RUNNER_HEADERS = """\
/*
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors {app}; object-src 'none'; base-uri 'none'; form-action 'none'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
/pyodide-*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
"""


def origin(value: str) -> str:
    parts = urlsplit(value)
    if parts.scheme not in ("http", "https") or not parts.netloc or parts.path not in ("", "/"):
        raise SystemExit(f"not an origin: {value!r} (want scheme://host[:port])")
    return f"{parts.scheme}://{parts.netloc}"


def browser_packages() -> list[str]:
    from leegen.envs.registry import EnvironmentRegistry

    pkgs = set(CORE_PACKAGES)
    for env in EnvironmentRegistry().all().values():
        if env.browser:
            pkgs.update(env.browser.packages)
    return sorted(pkgs)


def python_sources() -> dict[str, str]:
    """The Python the runner writes into Pyodide's filesystem under /lc."""
    files: dict[str, str] = {"leegen/__init__.py": ""}
    for path in sorted((PKG / "core").glob("*.py")):
        files[f"leegen/core/{path.name}"] = path.read_text()
    files["leegen/browser_runner.py"] = (PKG / "browser_runner.py").read_text()
    for path in sorted(HARNESS.glob("*.py")):
        files[f"leegen_harness/{path.name}"] = path.read_text()
    return files


def _section(path: Path, heading: str) -> str:
    """`heading` and its body, up to the next heading of the same level."""
    if not path.exists():
        return ""
    text = path.read_text()
    start = text.find(heading)
    if start < 0:
        return ""
    end = text.find("\n## ", start + len(heading))
    return text[start:end if end > 0 else None].strip() + "\n"


def app_data() -> tuple[dict, list[tuple[Path, str]]]:
    """data/bundle.json for the app, plus (source, dest) asset copies."""
    from leegen.envs.registry import EnvironmentRegistry
    from leegen.schema.export import problem_json_schema
    from leegen.store.problems import ProblemStore

    cfg = settings()
    store = ProblemStore()
    if store.errors():
        bad = ", ".join(e.path for e in store.errors())
        raise SystemExit(f"invalid problem files: {bad} (run `leegen validate --all`)")
    problems, assets = [], []
    for p in store.list():
        yaml_text = (store.dir / f"{p.id}.yaml").read_text()
        asset_dir = store.dir / p.id / "assets"
        names = sorted(str(f.relative_to(store.dir / p.id)) for f in asset_dir.rglob("*")
                       if f.is_file()) if asset_dir.is_dir() else []
        assets += [(store.dir / p.id / n, f"assets/{p.id}/{n}") for n in names]
        problems.append({"id": p.id, "yaml": yaml_text, "problem": p.model_dump(mode="json"),
                         "assets": names})
    guide = cfg.docs_dir / "authoring.md"
    browser_guide = cfg.docs_dir / "browser.md"
    data = {
        "problems": problems,
        "environments": [e.model_dump(mode="json") for e in EnvironmentRegistry().all().values()],
        "guides": {
            "authoring": guide.read_text() if guide.exists() else "",
            "tutoring": TUTORING_GUIDE,
            "browser": _section(browser_guide, "## Notes for agents"),
        },
        "schema": problem_json_schema(),
        "tools": json.loads((cfg.root / "contracts" / "tools.json").read_text()),
    }
    blob = json.dumps(data, sort_keys=True).encode()
    data["version"] = hashlib.sha256(blob).hexdigest()[:12]
    return data, assets


def _service_worker(template: Path, dest: Path, version: str, precache: list[str]) -> None:
    text = template.read_text()
    text = text.replace('"__VERSION__"', json.dumps(version))
    text = text.replace("__PRECACHE__", json.dumps(precache))
    dest.write_text(text)


def build(app_origin: str, runner_origin: str, out: Path, *, skip_vite: bool = False) -> None:
    app_origin, runner_origin = origin(app_origin), origin(runner_origin)
    if app_origin == runner_origin:
        raise SystemExit("the app and the runner must be different origins")
    cfg = settings()
    web = cfg.root / "web"
    out = out.resolve()
    app, runner = out / "app", out / "runner"

    # ------------------------------------------------------------ app
    if not skip_vite:
        if not (web / "node_modules").is_dir():
            subprocess.run(["npm", "install", "--no-fund", "--no-audit"], cwd=web, check=True)
        env = {**os.environ, "VITE_LEEGEN_EDITION": "browser"}
        subprocess.run(["npx", "tsc", "-b"], cwd=web, check=True)
        subprocess.run(["npx", "vite", "build", "--mode", "browser", "--outDir", str(app),
                        "--emptyOutDir"], cwd=web, check=True, env=env)
    elif not (app / "index.html").is_file():
        raise SystemExit(f"{app} has no build; run without --skip-vite first")
    shutil.rmtree(app / "data", ignore_errors=True)
    (app / "data").mkdir(parents=True)
    data, assets = app_data()
    (app / "data" / "bundle.json").write_text(json.dumps(data))
    for src, dest in assets:
        (app / "data" / dest).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(src, app / "data" / dest)
    (app / "config.json").write_text(json.dumps({"runner_origin": runner_origin,
                                                  "version": data["version"]}))
    (app / "_headers").write_text(APP_HEADERS.format(runner=runner_origin))
    entry = [str(f.relative_to(app)) for f in (app / "assets").glob("index-*") if f.is_file()]
    _service_worker(web / "sw" / "app-sw.js", app / "sw.js", data["version"],
                    ["/", "/theme-init.js", "/config.json", "/data/bundle.json",
                     *[f"/{e}" for e in sorted(entry)]])

    # ------------------------------------------------------------ runner
    shutil.rmtree(runner, ignore_errors=True)
    shutil.copytree(web / "runner", runner)
    packages = browser_packages()
    shutil.copytree(pyodide.ensure(packages), runner / f"pyodide-{pyodide.VERSION}")
    sources = python_sources()
    (runner / "lc-python.json").write_text(json.dumps(sources))
    (runner / "config.json").write_text(json.dumps({
        "allowed_parents": [app_origin],
        "pyodide": f"pyodide-{pyodide.VERSION}/",
        "preload": CORE_PACKAGES,
        "version": hashlib.sha256(json.dumps(sources, sort_keys=True).encode() + b"".join(
            (web / "runner" / n).read_bytes() for n in ("runner.js", "py-worker.js", "sw.js"))
            + pyodide.VERSION.encode()).hexdigest()[:12],
    }))
    (runner / "_headers").write_text(RUNNER_HEADERS.format(app=app_origin))
    runner_version = json.loads((runner / "config.json").read_text())["version"]
    pyodide_files = sorted(f"/pyodide-{pyodide.VERSION}/{f.name}"
                           for f in (runner / f"pyodide-{pyodide.VERSION}").iterdir() if f.is_file())
    _service_worker(runner / "sw.js", runner / "sw.js", runner_version,
                    ["/", "/runner.js", "/py-worker.js", "/config.json", "/lc-python.json",
                     *pyodide_files])

    # ------------------------------------------------------------ wrangler configs
    for site, name in (("app", "leegen"), ("runner", "leegen-runner")):
        conf = {"name": name, "compatibility_date": "2026-11-01",
                "assets": {"directory": f"./{site}"}}
        if site == "app":
            conf["assets"]["not_found_handling"] = "single-page-application"
        (out / f"wrangler.{site}.jsonc").write_text(json.dumps(conf, indent=2) + "\n")

    def size(p: Path) -> float:
        return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6

    print(f"app     {app_origin:<40} {size(app):6.1f} MB  {app}")
    print(f"runner  {runner_origin:<40} {size(runner):6.1f} MB  {runner}")
    print(f"problems: {len(data['problems'])}; pyodide packages: {', '.join(packages)}")
