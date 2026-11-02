"""Serve a browser-edition build locally, applying each site's `_headers` like the host does.

The app is opened as http://localhost:<app-port> and the runner is served as
http://127.0.0.1:<runner-port>, so they are different *sites*, as in production. Both are
secure contexts. Binds 127.0.0.1 only.
"""

from __future__ import annotations

import fnmatch
import functools
import http.server
import threading
from pathlib import Path

TYPES = {".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm",
         ".json": "application/json", ".whl": "application/octet-stream",
         ".zip": "application/zip", ".yaml": "text/yaml; charset=utf-8",
         ".css": "text/css", ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml",
         ".woff2": "font/woff2", ".ttf": "font/ttf"}


def parse_headers(path: Path) -> list[tuple[str, list[tuple[str, str]]]]:
    rules: list[tuple[str, list[tuple[str, str]]]] = []
    for line in path.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            rules.append((line.strip(), []))
        elif line.strip().startswith("!"):   # detach a header set by an earlier rule
            rules[-1][1].append((line.strip()[1:].strip(), ""))
        else:
            name, _, value = line.strip().partition(":")
            rules[-1][1].append((name.strip(), value.strip()))
    return rules


class _Handler(http.server.SimpleHTTPRequestHandler):
    rules: list[tuple[str, list[tuple[str, str]]]] = []
    spa = False

    def send_head(self):  # type: ignore[override]
        # single-page app: unknown extension-less paths get index.html (like the host's fallback)
        path = self.path.split("?", 1)[0]
        if self.spa and "." not in path.rsplit("/", 1)[-1]:
            target = Path(self.translate_path(path))
            if not target.exists():
                self.path = "/index.html"
        return super().send_head()

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        applied: dict[str, str] = {}
        for pattern, headers in self.rules:
            if fnmatch.fnmatch(path, pattern):
                for n, v in headers:
                    if v == "":
                        applied.pop(n, None)
                    else:
                        applied[n] = v
        for name, value in applied.items():
            self.send_header(name, value)
        if "Cache-Control" not in applied:
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def guess_type(self, path):  # type: ignore[override]
        return TYPES.get(Path(str(path)).suffix, super().guess_type(path))

    def log_message(self, fmt: str, *args) -> None:  # errors only
        if len(args) > 1 and str(args[1])[:1] in "45":
            super().log_message(fmt, *args)


def site(root: Path, port: int, *, spa: bool) -> http.server.ThreadingHTTPServer:
    rules = parse_headers(root / "_headers")
    handler = type(f"Handler{port}", (_Handler,), {"rules": rules, "spa": spa})
    return http.server.ThreadingHTTPServer(("127.0.0.1", port),
                                           functools.partial(handler, directory=str(root)))


def serve(build: Path, app_port: int, runner_port: int) -> int:
    if not (build / "app" / "index.html").is_file():
        raise SystemExit(f"no build in {build}; run `leetclaude browser build` first")
    servers = [site(build / "app", app_port, spa=True),
               site(build / "runner", runner_port, spa=False)]
    for s in servers:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print(f"app:    http://localhost:{app_port}/   (open this)")
    print(f"runner: http://127.0.0.1:{runner_port}/", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        for s in servers:
            s.shutdown()
    return 0
