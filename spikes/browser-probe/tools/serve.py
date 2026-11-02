"""Serve the probe's two static sites locally, applying each site's `_headers` file.

    python3 -I spikes/browser-probe/tools/serve.py            # app :13380, runner :13381

Binds 127.0.0.1 only. The app is opened as http://localhost:13380 and the runner as
http://127.0.0.1:13381, so they are different *sites*, as in production. Both count as
secure contexts. Ctrl-C stops both.
"""

from __future__ import annotations

import argparse
import fnmatch
import functools
import http.server
import threading
from pathlib import Path

SPIKE = Path(__file__).resolve().parent.parent

TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
         ".json": "application/json", ".whl": "application/octet-stream",
         ".zip": "application/zip", ".yaml": "text/yaml; charset=utf-8", ".py": "text/plain; charset=utf-8",
         ".css": "text/css", ".html": "text/html; charset=utf-8"}


def parse_headers(path: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    rules: list[tuple[str, list[tuple[str, str]]]] = []
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            rules.append((line.strip(), []))
        else:
            name, _, value = line.strip().partition(":")
            rules[-1][1].append((name.strip(), value.strip()))
    return rules


class Handler(http.server.SimpleHTTPRequestHandler):
    rules: list[tuple[str, list[tuple[str, str]]]] = []

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        for pattern, headers in self.rules:
            if fnmatch.fnmatch(path, pattern):
                for name, value in headers:
                    self.send_header(name, value)
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):  # type: ignore[override]
        return TYPES.get(Path(str(path)).suffix, super().guess_type(path))

    def log_message(self, fmt: str, *args) -> None:  # quieter: errors only
        if args and str(args[1])[:1] in "45":
            super().log_message(fmt, *args)


def site(root: Path, port: int) -> http.server.ThreadingHTTPServer:
    rules = parse_headers(root / "_headers")
    handler = type(f"Handler{port}", (Handler,), {"rules": rules})
    return http.server.ThreadingHTTPServer(("127.0.0.1", port),
                                           functools.partial(handler, directory=str(root)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", type=Path, default=SPIKE / "build")
    ap.add_argument("--app-port", type=int, default=13380)
    ap.add_argument("--runner-port", type=int, default=13381)
    args = ap.parse_args()
    servers = [site(args.build / "app", args.app_port), site(args.build / "runner", args.runner_port)]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"app:    http://localhost:{args.app_port}/   (open this)")
    print(f"runner: http://127.0.0.1:{args.runner_port}/", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for s in servers:
            s.shutdown()


if __name__ == "__main__":
    main()
