"""Single-command launchers.

`leetclaude start` builds the web UI if needed, then serves UI + REST + MCP on one port.
`leetclaude dev` runs the backend with --reload and the Vite dev server (HMR) side by side.
`leetclaude stop` stops a server started by either, from any terminal.

Each launcher records its own PID in <cache>/run/server-<port>.json. `stop` only ever signals
that exact PID (or, for servers without a pidfile, the process listening on the port), and only
after checking that its command line is a leetclaude entry point.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from leetclaude.config import settings

# Set for the backend child of `dev`, so only the supervisor registers (and gets stopped).
_SUPERVISED = "LEETCLAUDE_SUPERVISED"

# Inputs of `npm run build`; if any is newer than dist/index.html the bundle is rebuilt.
_UI_SOURCES = ("src", "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json")


class LaunchError(SystemExit):
    """Startup problem with a message meant for the user (exit status 1)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


# ---------------------------------------------------------------- checks


def port_free(host: str, port: int) -> bool:
    """False if something listens on host:port. Mirrors uvicorn (SO_REUSEADDR), so sockets
    lingering in TIME_WAIT after a previous run don't count as "in use"."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        if probe.connect_ex((host, port)) == 0:
            return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
    return True


def ensure_port(host: str, port: int, env_var: str) -> None:
    if not port_free(host, port):
        raise LaunchError(
            f"leetclaude: {host}:{port} is already in use by another program.\n"
            f"  Stop it, or pick another port: {env_var}=<port> (or --port)."
        )


def _newest_mtime(path: Path) -> float:
    if path.is_file():
        return path.stat().st_mtime
    if path.is_dir():
        return max((p.stat().st_mtime for p in path.rglob("*") if p.is_file()), default=0.0)
    return 0.0


def ui_is_stale(web_dir: Path) -> bool:
    """True if web/dist is missing or older than any build input."""
    built = web_dir / "dist" / "index.html"
    if not built.exists():
        return True
    newest = max(_newest_mtime(web_dir / name) for name in _UI_SOURCES)
    return newest > built.stat().st_mtime


def deps_missing(web_dir: Path) -> bool:
    marker = web_dir / "node_modules" / ".package-lock.json"
    lock = web_dir / "package-lock.json"
    if not marker.exists():
        return True
    return lock.exists() and lock.stat().st_mtime > marker.stat().st_mtime


# ---------------------------------------------------------------- start


def ensure_ui(web_dir: Path) -> None:
    """Install web deps and (re)build the bundle when needed. Never fatal if a bundle exists."""
    if not deps_missing(web_dir) and not ui_is_stale(web_dir):
        return
    npm = shutil.which("npm")
    have_dist = (web_dir / "dist" / "index.html").exists()
    if npm is None:
        print("leetclaude: npm not found; "
              + ("serving the existing (possibly outdated) web UI." if have_dist
                 else "the web UI is not built, only the API and MCP are available."),
              file=sys.stderr)
        return
    try:
        if deps_missing(web_dir):
            print("leetclaude: installing web dependencies (npm install)…", flush=True)
            subprocess.run([npm, "install", "--no-fund", "--no-audit"], cwd=web_dir, check=True)
        if ui_is_stale(web_dir):
            print("leetclaude: building the web UI (npm run build)…", flush=True)
            subprocess.run([npm, "run", "build"], cwd=web_dir, check=True)
    except subprocess.CalledProcessError as exc:
        if not have_dist:
            raise LaunchError(f"leetclaude: web UI build failed ({exc}).") from exc
        print(f"leetclaude: web UI build failed ({exc}); serving the previous build.", file=sys.stderr)


def banner(ui_url: str, api_url: str) -> str:
    mcp = f"{api_url}/mcp"
    return (
        "\n"
        f"  leetclaude\n"
        f"  ─────────────────────────────────────────────\n"
        f"  UI   {ui_url}\n"
        f"  MCP  {mcp}\n"
        f"       claude mcp add --transport http leetclaude {mcp}\n"
    )


def serve(host: str, port: int, *, reload: bool = False, mode: str = "serve") -> int:
    import uvicorn

    ensure_port(host, port, "LEETCLAUDE_PORT")

    # uvicorn shuts down gracefully on SIGTERM, then re-raises it with the previous handler
    # restored; make that a normal exit so `leetclaude stop` doesn't look like a crash (143).
    def _exit_cleanly(signum: int, frame: object) -> None:
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _exit_cleanly)
    with registered(port, mode, host=host):
        uvicorn.run("leetclaude.app:app", host=host, port=port, reload=reload,
                    reload_dirs=[str(Path(__file__).parent)] if reload else None)
    return 0


def start(host: str, port: int, *, build: bool = True) -> int:
    ensure_port(host, port, "LEETCLAUDE_PORT")
    if build:
        ensure_ui(settings().web_dir)
    url = f"http://{host}:{port}"
    print(banner(url, url) + "  Stop with Ctrl-C or `make stop`.\n", flush=True)
    return serve(host, port, mode="start")


# ---------------------------------------------------------------- pidfile + stop

# argv contains the `leetclaude` console script or the `leetclaude.cli` module, not merely a path
# that runs through the repo directory (e.g. .../leetclaude/web/node_modules/...).
_ENTRY = re.compile(r"(?:^|[\s/])leetclaude(?:\.cli)?(?:\s|$)")


def pidfile(port: int) -> Path:
    return settings().cache_dir / "run" / f"server-{port}.json"


@contextmanager
def registered(port: int, mode: str, **extra: object) -> Iterator[None]:
    """Record this process as the leetclaude server on `port` for the duration of the block."""
    if os.environ.get(_SUPERVISED):
        yield
        return
    path = pidfile(port)
    path.parent.mkdir(parents=True, exist_ok=True)
    me = os.getpid()
    path.write_text(json.dumps({"pid": me, "mode": mode, "port": port, "started_at": time.time(), **extra}))
    try:
        yield
    finally:
        try:
            if json.loads(path.read_text()).get("pid") == me:
                path.unlink()
        except (OSError, ValueError):
            pass


def _command(pid: int) -> str:
    try:
        out = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True)
    except FileNotFoundError:
        return ""
    return out.stdout.strip()


def is_leetclaude(pid: int) -> bool:
    return bool(_ENTRY.search(_command(pid)))


def _alive(pid: int) -> bool:
    try:  # reap it if it happens to be our own child (otherwise it lingers as a zombie)
        if os.waitpid(pid, os.WNOHANG)[0] == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _listeners(port: int) -> list[int]:
    try:
        out = subprocess.run(["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"],
                             capture_output=True, text=True)
    except FileNotFoundError:
        return []
    return sorted({int(x) for x in out.stdout.split()})


def _terminate(pid: int, timeout: float) -> bool:
    """SIGTERM, wait, then SIGKILL. True if the process is gone."""
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        return True
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if not _alive(pid):
            return True
        time.sleep(0.1)
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        return True
    time.sleep(0.3)
    return not _alive(pid)


def stop(port: int, *, timeout: float = 10.0) -> int:
    """Stop the leetclaude server (start, serve or dev) on `port`. 0 if none is left running."""
    path = pidfile(port)
    targets: list[tuple[int, str]] = []
    if path.exists():
        try:
            info = json.loads(path.read_text())
        except (OSError, ValueError):
            info = {}
        pid = int(info.get("pid") or 0)
        if pid and _alive(pid) and is_leetclaude(pid):
            targets.append((pid, str(info.get("mode", "server"))))
        else:
            path.unlink(missing_ok=True)  # stale: process gone, or the PID now belongs to something else
    if not targets:
        # No usable pidfile (e.g. a server started before pidfiles existed): fall back to whatever
        # listens on the port, but only leetclaude processes. With --reload both the reloader and
        # its worker hold the socket; the worker's argv isn't ours, and stopping the reloader stops it.
        listeners = _listeners(port)
        targets = [(pid, "server") for pid in listeners if is_leetclaude(pid)]
        if not targets:
            if listeners or not port_free("127.0.0.1", port):
                who = ", ".join(f"{pid} ({_command(pid)[:80]})" for pid in listeners) or "an unknown process"
                print(f"leetclaude stop: port {port} is held by {who}, which is not a leetclaude server; "
                      "leaving it alone.", file=sys.stderr)
                return 1
            print(f"leetclaude stop: no leetclaude server running on port {port}.")
            return 0
    ok = True
    for pid, mode in targets:
        if _terminate(pid, timeout):
            print(f"leetclaude stop: stopped `{mode}` (pid {pid}) on port {port}.")
        else:
            ok = False
            print(f"leetclaude stop: pid {pid} did not exit.", file=sys.stderr)
    if ok:
        path.unlink(missing_ok=True)
    return 0 if ok else 1


# ---------------------------------------------------------------- dev


def _pump(proc: subprocess.Popen[bytes], prefix: str) -> None:
    assert proc.stdout is not None
    for raw in iter(proc.stdout.readline, b""):
        sys.stdout.write(f"{prefix} {raw.decode(errors='replace').rstrip()}\n")
        sys.stdout.flush()


def _stop(procs: list[subprocess.Popen[bytes]]) -> None:
    for p in procs:
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
    deadline = time.monotonic() + 5
    for p in procs:
        try:
            p.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def dev(host: str, port: int, web_port: int) -> int:
    web_dir = settings().web_dir
    npm = shutil.which("npm")
    if npm is None:
        raise LaunchError("leetclaude dev: npm not found (needed for the Vite dev server).")
    ensure_port(host, port, "LEETCLAUDE_PORT")
    ensure_port("127.0.0.1", web_port, "LEETCLAUDE_WEB_PORT")
    if deps_missing(web_dir):
        print("leetclaude: installing web dependencies (npm install)…", flush=True)
        subprocess.run([npm, "install", "--no-fund", "--no-audit"], cwd=web_dir, check=True)

    api_url = f"http://{host}:{port}"
    env = {**os.environ, "LEETCLAUDE_API": api_url, "LEETCLAUDE_PORT": str(port),
           "LEETCLAUDE_WEB_PORT": str(web_port), "FORCE_COLOR": "1", _SUPERVISED: "1"}
    common = dict(stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=env)
    procs = [
        subprocess.Popen([sys.executable, "-m", "leetclaude.cli", "serve", "--reload",
                          "--host", host, "--port", str(port)], **common),  # type: ignore[call-overload]
        subprocess.Popen([npm, "run", "dev", "--", "--host", "127.0.0.1"], cwd=web_dir,
                         **common),  # type: ignore[call-overload]
    ]
    for proc, prefix in zip(procs, ("\033[36mapi │\033[0m", "\033[35mweb │\033[0m")):
        threading.Thread(target=_pump, args=(proc, prefix), daemon=True).start()
    print(banner(f"http://127.0.0.1:{web_port}  (hot reload)", api_url)
          + "  Ctrl-C (or `make stop`) stops both.\n", flush=True)

    # Children run in their own sessions, so terminal signals reach only us; turn SIGINT,
    # SIGTERM and SIGHUP (closed terminal) into one clean shutdown of both process groups.
    def _interrupt(signum: int, frame: object) -> None:
        raise KeyboardInterrupt

    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, _interrupt)

    code = 0
    with registered(port, "dev", host=host, web_port=web_port):
        try:
            while True:
                done = [p for p in procs if p.poll() is not None]
                if done:
                    code = done[0].returncode or 0
                    print(f"leetclaude dev: a process exited ({code}); stopping.", flush=True)
                    break
                time.sleep(0.2)
        except KeyboardInterrupt:
            print("\nleetclaude dev: stopping…", flush=True)
        finally:
            _stop(procs)
    return code
