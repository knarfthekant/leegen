"""Launcher helpers: port settings, UI staleness, port-in-use errors."""

import os
import socket
import time
from pathlib import Path

import pytest

from leegen import config
from leegen.devserver import LaunchError, deps_missing, ensure_port, port_free, ui_is_stale


def test_port_defaults_and_env_override(monkeypatch: pytest.MonkeyPatch) -> None:
    for var in ("LEEGEN_PORT", "LEEGEN_WEB_PORT", "LEEGEN_HOST"):
        monkeypatch.delenv(var, raising=False)
    config.settings.cache_clear()
    try:
        s = config.settings()
        assert (s.host, s.port, s.web_port) == ("127.0.0.1", 13370, 13371)
        monkeypatch.setenv("LEEGEN_PORT", "14000")
        monkeypatch.setenv("LEEGEN_WEB_PORT", "14001")
        config.settings.cache_clear()
        s = config.settings()
        assert (s.port, s.web_port) == (14000, 14001)
    finally:
        monkeypatch.undo()
        config.settings.cache_clear()


def _touch(path: Path, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("x")
    os.utime(path, (mtime, mtime))


def test_ui_staleness(tmp_path: Path) -> None:
    now = time.time()
    _touch(tmp_path / "src" / "App.tsx", now - 100)
    assert ui_is_stale(tmp_path)  # no dist yet
    _touch(tmp_path / "dist" / "index.html", now - 50)
    assert not ui_is_stale(tmp_path)
    _touch(tmp_path / "src" / "components" / "New.tsx", now)
    assert ui_is_stale(tmp_path)
    _touch(tmp_path / "dist" / "index.html", now + 10)
    assert not ui_is_stale(tmp_path)


def test_deps_missing(tmp_path: Path) -> None:
    now = time.time()
    _touch(tmp_path / "package-lock.json", now - 100)
    assert deps_missing(tmp_path)
    _touch(tmp_path / "node_modules" / ".package-lock.json", now - 50)
    assert not deps_missing(tmp_path)
    _touch(tmp_path / "package-lock.json", now)
    assert deps_missing(tmp_path)


def test_port_in_use_is_reported() -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        s.listen()
        port = s.getsockname()[1]
        assert not port_free("127.0.0.1", port)
        with pytest.raises(LaunchError, match="LEEGEN_PORT"):
            ensure_port("127.0.0.1", port, "LEEGEN_PORT")


# ---------------------------------------------------------------- stop

import json  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402

from leegen import devserver  # noqa: E402

# A stand-in "server": argv[0] of the script is a file named `leegen`, so `ps` shows
# ".../leegen serve" just like the real console script. It listens on the given port.
_FAKE_SERVER = """
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[2]))); s.listen()
time.sleep(60)
"""


@pytest.fixture
def run_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("LEEGEN_CACHE", str(tmp_path / "cache"))
    config.settings.cache_clear()
    yield tmp_path
    monkeypatch.undo()
    config.settings.cache_clear()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _spawn(tmp_path: Path, name: str, port: int) -> subprocess.Popen[bytes]:
    script = tmp_path / name
    script.write_text(_FAKE_SERVER)
    proc = subprocess.Popen([sys.executable, str(script), "serve", str(port)])
    for _ in range(50):
        if not devserver.port_free("127.0.0.1", port):
            return proc
        time.sleep(0.1)
    proc.kill()
    raise AssertionError("fake server did not start")


def test_entry_point_match() -> None:
    m = devserver._ENTRY.search
    assert m("/repo/server/.venv/bin/python /repo/server/.venv/bin/leegen start")
    assert m("python -m leegen.cli serve --reload --port 13370")
    assert not m("node /Users/x/leegen/web/node_modules/.bin/vite --host 127.0.0.1")
    assert not m("python -c from multiprocessing.spawn import spawn_main")


def test_registered_writes_and_removes_pidfile(run_dir: Path) -> None:
    with devserver.registered(14999, "start"):
        info = json.loads(devserver.pidfile(14999).read_text())
        assert info["pid"] == os.getpid() and info["mode"] == "start"
    assert not devserver.pidfile(14999).exists()


def test_stop_uses_pidfile(run_dir: Path) -> None:
    port = _free_port()
    proc = _spawn(run_dir, "leegen", port)
    try:
        path = devserver.pidfile(port)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"pid": proc.pid, "mode": "dev"}))
        assert devserver.stop(port, timeout=5) == 0
        assert proc.wait(timeout=5) is not None
        assert not path.exists()
    finally:
        proc.kill()


def test_stop_falls_back_to_leegen_listener(run_dir: Path) -> None:
    port = _free_port()
    proc = _spawn(run_dir, "leegen", port)
    try:
        assert devserver.stop(port, timeout=5) == 0  # no pidfile
        assert proc.wait(timeout=5) is not None
    finally:
        proc.kill()


def test_stop_leaves_other_programs_alone(run_dir: Path) -> None:
    port = _free_port()
    proc = _spawn(run_dir, "someone_elses_server", port)
    try:
        # a stale pidfile pointing at a non-leegen PID must not get it killed either
        path = devserver.pidfile(port)
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({"pid": proc.pid, "mode": "start"}))
        assert devserver.stop(port, timeout=1) == 1
        assert proc.poll() is None
        assert not path.exists()  # stale entry cleaned up
    finally:
        proc.kill()
        proc.wait()


def test_stop_when_nothing_runs(run_dir: Path) -> None:
    assert devserver.stop(_free_port()) == 0
