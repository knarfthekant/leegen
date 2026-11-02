"""Shared helpers: module scoping, timeouts, stdout capture, user-facing tracebacks.

Runs natively (CPython in a venv) and in the browser (Pyodide). Where the two differ:
- per-test timeouts: SIGALRM natively; in Pyodide (no setitimer) the runner enforces wall time
  from outside (interrupt buffer, then worker termination), so `alarm` only checks the deadline;
- coroutines: `asyncio.run` natively; Pyodide's running WebLoop needs `pyodide.ffi.run_sync`.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import importlib.util
import io
import os
import signal
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Iterator


class TestTimeout(BaseException):
    """Raised by the alarm handler. BaseException so user `except Exception` can't swallow it."""


class Deadline:
    def __init__(self, seconds: float) -> None:
        self.end = time.monotonic() + seconds

    def remaining(self) -> float:
        return self.end - time.monotonic()

    def expired(self) -> bool:
        return self.remaining() <= 0


HAS_ALARM = hasattr(signal, "setitimer") and hasattr(signal, "SIGALRM")


@contextlib.contextmanager
def alarm(seconds: float) -> Iterator[None]:
    if seconds <= 0:
        raise TestTimeout()
    if not HAS_ALARM:   # Pyodide: the runner stops runaway code from outside the interpreter
        yield
        return

    def handler(signum: int, frame: Any) -> None:
        raise TestTimeout()

    old = signal.signal(signal.SIGALRM, handler)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


def run_coro(coro: Any) -> Any:
    """Run a coroutine to completion, natively or under Pyodide's already-running loop."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    try:   # a loop is running: only possible in Pyodide, via JSPI stack switching
        from pyodide.ffi import run_sync  # type: ignore[import-not-found]
    except ImportError:
        coro.close()
        raise RuntimeError("cannot run a coroutine inside a running event loop") from None
    return run_sync(coro)


@contextlib.contextmanager
def capture() -> Iterator[io.StringIO]:
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        yield buf


def module_name(path: str) -> str:
    return path[:-3].replace("/", ".") if path.endswith(".py") else path.replace("/", ".")


@contextlib.contextmanager
def module_scope(directory: Path) -> Iterator[None]:
    """Import code from `directory`, then forget every module loaded from it.

    Lets the reference and the user's solution (same module names) run in one process.
    """
    directory = directory.resolve()
    before = set(sys.modules)
    old_path = list(sys.path)
    old_cwd = os.getcwd()
    sys.path.insert(0, str(directory))
    os.chdir(directory)
    importlib.invalidate_caches()
    try:
        yield
    finally:
        os.chdir(old_cwd)
        sys.path[:] = old_path
        for name in set(sys.modules) - before:
            mod = sys.modules.get(name)
            file = getattr(mod, "__file__", None) or ""
            if file and Path(file).resolve().is_relative_to(directory):
                del sys.modules[name]


def resolve(spec: str) -> Any:
    """'solution.py:name' or 'solution.py:Class.method' -> object, imported normally."""
    file, _, attr = spec.partition(":")
    obj: Any = importlib.import_module(module_name(file))
    for part in attr.split("."):
        obj = getattr(obj, part)
    return obj


def load_isolated(directory: Path, spec: str) -> Any:
    """Load `file.py:name` from `directory` under a private module name (generators, comparators)."""
    file, _, attr = spec.partition(":")
    path = (directory / file).resolve()
    name = "_lc_aux_" + module_name(file).replace(".", "_")
    mod = sys.modules.get(name)
    if mod is None or getattr(mod, "__file__", None) != str(path):
        loaded = importlib.util.spec_from_file_location(name, path)
        if loaded is None or loaded.loader is None:
            raise ImportError(f"cannot load {file}")
        mod = importlib.util.module_from_spec(loaded)
        sys.modules[name] = mod
        old = list(sys.path)
        sys.path.insert(0, str(directory))
        try:
            loaded.loader.exec_module(mod)
        finally:
            sys.path[:] = old
    obj: Any = mod
    for part in attr.split("."):
        obj = getattr(obj, part)
    return obj


def user_traceback(exc: BaseException) -> str:
    """Traceback without harness/importlib frames, with paths relative to the user's files."""
    harness_dir = os.path.realpath(Path(__file__).parent)
    bundle_dir = os.path.dirname(harness_dir.rstrip("/").rsplit("/_lc", 1)[0] + "/x")
    frames = []
    for f in traceback.extract_tb(exc.__traceback__):
        real = os.path.realpath(f.filename) if not f.filename.startswith("<") else f.filename
        if real.startswith(harness_dir) or f.filename.startswith("<frozen") or "importlib" in real:
            continue
        for sub in ("/user/", "/ref/"):
            prefix = bundle_dir + sub
            if real.startswith(prefix):
                f.filename = real[len(prefix):]
        frames.append(f)
    lines = traceback.format_list(frames) if frames else []
    text = "".join(traceback.format_exception_only(type(exc), exc))
    for sub in ("/user/", "/ref/"):  # SyntaxError embeds the file path in the message
        text = text.replace(bundle_dir + sub, "")
        text = text.replace(bundle_dir.replace("/private/var/", "/var/", 1) + sub, "")
    if frames:
        return "Traceback (most recent call last):\n" + "".join(lines) + text
    return text


def sync_device() -> None:
    torch = sys.modules.get("torch")
    if torch is None:
        return
    if torch.cuda.is_available():
        torch.cuda.synchronize()
    elif getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        torch.mps.synchronize()


