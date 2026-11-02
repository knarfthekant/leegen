"""Self-host Pyodide: fetch the core runtime plus chosen packages, verified, into one directory.

    python3 -I spikes/browser-probe/tools/fetch_pyodide.py \
        --out spikes/browser-probe/vendor/pyodide --packages pytest pydantic

* The core comes from the npm tarball, checked against the registry's sha512 `integrity`.
* Packages (and their dependencies, resolved from pyodide-lock.json) come from the release CDN,
  checked against the sha256 in the lock file.
* Downloads land in a fresh temp directory first and are only copied out after verification.
  Nothing downloaded is executed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
import shutil
import tarfile
import tempfile
import urllib.request
from pathlib import Path

CORE_FILES = {"pyodide.mjs", "pyodide.js", "pyodide.asm.mjs", "pyodide.asm.wasm",
              "python_stdlib.zip", "pyodide-lock.json", "package.json"}


def fetch(url: str, dest: Path) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as resp:   # noqa: S310 (fixed https URLs)
        data = resp.read()
    dest.write_bytes(data)
    return data


def _norm(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()   # PEP 503


def resolve(lock: dict, wanted: list[str]) -> list[str]:
    pkgs = lock["packages"]
    by_norm = {_norm(k): k for k in pkgs}
    seen: list[str] = []
    stack = list(wanted)
    while stack:
        raw = stack.pop()
        name = by_norm.get(_norm(raw))
        if name is None:
            raise SystemExit(f"package {raw!r} is not in pyodide-lock.json")
        if name in seen:
            continue
        seen.append(name)
        stack.extend(pkgs[name].get("depends", []))
    return sorted(seen)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", default="314.0.7")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--packages", nargs="*", default=["pytest", "pydantic", "pyyaml"])
    args = ap.parse_args()

    meta_url = f"https://registry.npmjs.org/pyodide/{args.version}"
    with urllib.request.urlopen(meta_url, timeout=60) as resp:   # noqa: S310
        meta = json.load(resp)
    algo, b64 = meta["dist"]["integrity"].split("-", 1)
    if algo != "sha512":
        raise SystemExit(f"unexpected integrity algorithm {algo}")

    with tempfile.TemporaryDirectory(prefix="pyodide-dl-") as tmp_s:
        tmp = Path(tmp_s)
        tgz = tmp / "pyodide.tgz"
        data = fetch(meta["dist"]["tarball"], tgz)
        if hashlib.sha512(data).digest() != base64.b64decode(b64):
            raise SystemExit("npm tarball failed its integrity check")
        stage = tmp / "stage"
        stage.mkdir()
        with tarfile.open(tgz) as tar:
            members = [m for m in tar.getmembers()
                       if m.isfile() and m.name.removeprefix("package/") in CORE_FILES]
            tar.extractall(stage, members=members, filter="data")
        core = stage / "package"
        missing = CORE_FILES - {p.name for p in core.iterdir()}
        if missing - {"pyodide.js"}:
            raise SystemExit(f"tarball is missing {sorted(missing)}")

        lock = json.loads((core / "pyodide-lock.json").read_text())
        names = resolve(lock, args.packages) if args.packages else []
        cdn = f"https://cdn.jsdelivr.net/pyodide/v{args.version}/full/"
        for name in names:
            info = lock["packages"][name]
            dest = core / info["file_name"]
            blob = fetch(cdn + info["file_name"], dest)
            if hashlib.sha256(blob).hexdigest() != info["sha256"]:
                raise SystemExit(f"{info['file_name']} failed its sha256 check")

        if args.out.exists():
            shutil.rmtree(args.out)
        shutil.copytree(core, args.out)

    total = sum(p.stat().st_size for p in args.out.iterdir())
    print(f"pyodide {args.version} -> {args.out} ({total / 1e6:.1f} MB)")
    print("packages:", ", ".join(names) or "(none)")
    for p in sorted(args.out.iterdir(), key=lambda p: -p.stat().st_size)[:5]:
        print(f"  {p.stat().st_size / 1e6:6.1f} MB  {p.name}")


if __name__ == "__main__":
    main()
