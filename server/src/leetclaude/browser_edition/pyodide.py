"""Self-host Pyodide: the core runtime plus the packages the browser environments need.

* The core comes from the npm tarball, checked against the registry's sha512 `integrity`.
* Packages (and their dependencies, resolved from pyodide-lock.json) come from the release CDN,
  checked against the sha256 in the lock file.
* Downloads land in a fresh temp directory and are copied into the cache only after every check
  passes. Nothing downloaded is executed here.

The result is cached in ~/.cache/leetclaude/pyodide/<version>-<packages hash>/.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

VERSION = "314.0.7"
CORE_FILES = {"pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip",
              "pyodide-lock.json", "package.json"}
CACHE = Path.home() / ".cache" / "leetclaude" / "pyodide"


def _fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as resp:   # noqa: S310 (fixed https URLs)
        return resp.read()


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()   # PEP 503


def resolve(lock: dict, wanted: list[str]) -> list[str]:
    """`wanted` plus their dependencies, as lock-file names."""
    pkgs = lock["packages"]
    by_norm = {_norm(k): k for k in pkgs}
    seen: list[str] = []
    stack = list(wanted)
    while stack:
        raw = stack.pop()
        name = by_norm.get(_norm(raw))
        if name is None:
            raise SystemExit(f"package {raw!r} is not in Pyodide {VERSION}'s pyodide-lock.json")
        if name in seen:
            continue
        seen.append(name)
        stack.extend(pkgs[name].get("depends", []))
    return sorted(seen)


def ensure(packages: list[str], version: str = VERSION) -> Path:
    """Directory holding Pyodide `version` + `packages`, downloading it once."""
    key = hashlib.sha256(",".join(sorted(set(packages))).encode()).hexdigest()[:10]
    target = CACHE / f"{version}-{key}"
    if (target / "pyodide.mjs").is_file():
        return target

    meta = json.loads(_fetch(f"https://registry.npmjs.org/pyodide/{version}"))
    algo, b64 = meta["dist"]["integrity"].split("-", 1)
    if algo != "sha512":
        raise SystemExit(f"unexpected npm integrity algorithm {algo}")
    print(f"fetching Pyodide {version} + {', '.join(sorted(packages))} ...", flush=True)
    with tempfile.TemporaryDirectory(prefix="pyodide-dl-") as tmp_s:
        tmp = Path(tmp_s)
        data = _fetch(meta["dist"]["tarball"])
        if hashlib.sha512(data).digest() != base64.b64decode(b64):
            raise SystemExit("Pyodide npm tarball failed its integrity check")
        (tmp / "pyodide.tgz").write_bytes(data)
        stage = tmp / "stage"
        stage.mkdir()
        with tarfile.open(tmp / "pyodide.tgz") as tar:
            members = [m for m in tar.getmembers()
                       if m.isfile() and m.name.removeprefix("package/") in CORE_FILES]
            tar.extractall(stage, members=members, filter="data")
        core = stage / "package"
        missing = CORE_FILES - {p.name for p in core.iterdir()}
        if missing:
            raise SystemExit(f"Pyodide tarball is missing {sorted(missing)}")

        lock = json.loads((core / "pyodide-lock.json").read_text())
        cdn = f"https://cdn.jsdelivr.net/pyodide/v{version}/full/"
        for name in resolve(lock, packages):
            info = lock["packages"][name]
            blob = _fetch(cdn + info["file_name"])
            if hashlib.sha256(blob).hexdigest() != info["sha256"]:
                raise SystemExit(f"{info['file_name']} failed its sha256 check")
            (core / info["file_name"]).write_bytes(blob)

        target.parent.mkdir(parents=True, exist_ok=True)
        partial = target.with_name(target.name + ".partial")
        shutil.rmtree(partial, ignore_errors=True)
        shutil.copytree(core, partial)
        partial.rename(target)
    return target
