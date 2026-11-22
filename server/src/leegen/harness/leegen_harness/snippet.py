"""Console snippets: run user code inside the problem's files, Jupyter-style.

The bundle is the same as a test run (`user/` holds the problem files with the user's edits).
If `run.json` names a file, it is imported first and the snippet executes in that module's
namespace, so a selected call can reach the functions defined in the editor. A trailing
expression is evaluated and its repr is reported as the run's `result`; `console_done` is the
last event, and stdout/stderr stream as `output` events while the code runs.

Stdlib only, and it must stay Pyodide-safe: no subprocesses, and timeouts rely on `alarm()`'s
deadline fallback when `signal.setitimer` is missing.
"""

from __future__ import annotations

import ast
import contextlib
import importlib
import io
import sys
import textwrap
import time
from pathlib import Path
from typing import Any

from leegen_harness._common import (Deadline, TestTimeout, alarm, module_name, module_scope,
                                   user_traceback)
from leegen_harness.protocol import emit, truncate

MAX_STREAM = 200_000


class _Stream(io.StringIO):
    """A stdout/stderr replacement that forwards writes as `output` events."""

    def __init__(self, stream: str) -> None:
        super().__init__()
        self.stream = stream
        self.sent = 0

    def write(self, text: str) -> int:
        if self.sent < MAX_STREAM:
            piece = text[: MAX_STREAM - self.sent]
            if piece:
                emit({"type": "output", "stream": self.stream, "text": piece})
                self.sent += len(piece)
        return len(text)

    def flush(self) -> None:
        return None


def _load_context(user_dir: Path, file: str | None) -> dict[str, Any]:
    if not file:
        return {"__name__": "__console__"}
    root = user_dir.resolve()
    path = (root / file).resolve()
    if not path.is_relative_to(root) or not path.exists():
        raise FileNotFoundError(f"no file {file!r} in the problem")
    name = module_name(file)
    sys.modules.pop(name, None)
    return vars(importlib.import_module(name))


def _exec_selection(code: str, ns: dict[str, Any]) -> str | None:
    """Execute dedented code in `ns`; return repr of a trailing expression, if any."""
    code = textwrap.dedent(code)
    if not code.strip():
        return None
    echo = not code.rstrip().endswith(";")
    tree = ast.parse(code, filename="<console>", mode="exec")
    value: Any = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
        exec(compile(prefix, "<console>", "exec"), ns)
        expr = ast.fix_missing_locations(ast.Expression(tree.body[-1].value))
        value = eval(compile(expr, "<console>", "eval"), ns)
    else:
        exec(compile(tree, "<console>", "exec"), ns)
    return repr(value) if value is not None and echo else None


def _run_prior(prior: list[str], ns: dict[str, Any]) -> None:
    """Replay earlier tutorial cells silently. A failure names the cell that raised."""
    sink = _Mute()
    for i, code in enumerate(prior, 1):
        with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            try:
                _exec_selection(code, ns)
            except (KeyboardInterrupt, TestTimeout):
                raise
            except BaseException as exc:  # noqa: BLE001
                raise _PriorFailed(i, user_traceback(exc)) from None


class _Mute(io.StringIO):
    def write(self, text: str) -> int:
        return len(text)


class _PriorFailed(Exception):
    def __init__(self, number: int, trace: str) -> None:
        super().__init__(f"an earlier cell failed (code cell {number}):\n{trace}")


def _run_checks(checks: list[dict[str, Any]], ns: dict[str, Any]) -> None:
    """Run each check on a copy of the namespace and emit one `check` event per check."""
    for ck in checks:
        status, message = "pass", ""
        sink = _Mute()
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                exec(compile(textwrap.dedent(ck.get("code") or ""), "<check>", "exec"), dict(ns))
        except (KeyboardInterrupt, TestTimeout):
            raise
        except AssertionError as exc:
            status, message = "fail", str(exc)
        except BaseException as exc:  # noqa: BLE001 - user objects may raise anything
            status, message = "error", f"{type(exc).__name__}: {exc}"
        emit({"type": "check", "description": ck.get("description") or "", "status": status,
              "message": truncate(message, 2_000) or ""})


def run(cfg: dict[str, Any]) -> None:
    started = time.perf_counter()
    spec = cfg.get("snippet") or {}
    user_dir = Path(cfg["user_dir"])
    deadline = Deadline(float(cfg.get("timeout_s") or 30.0))
    status, error, value = "ok", None, None
    old_in, old_out, old_err = sys.stdin, sys.stdout, sys.stderr
    try:
        sys.stdin = io.StringIO(spec.get("stdin") or "")
        with (contextlib.redirect_stdout(_Stream("stdout")),
              contextlib.redirect_stderr(_Stream("stderr")),
              module_scope(user_dir),
              alarm(max(deadline.remaining(), 0.001))):
            notebook = spec.get("prior") is not None or bool(spec.get("checks"))
            ns = ({"__name__": "__tutorial__"} if notebook
                  else _load_context(user_dir, spec.get("file")))
            if notebook:
                _run_prior(spec.get("prior") or [], ns)
            value = _exec_selection(spec.get("code") or "", ns)
            if notebook and spec.get("checks"):
                _run_checks(spec["checks"], ns)
    except KeyboardInterrupt:
        raise   # the browser runner's soft stop: the caller assembles a timeout/cancel
    except TestTimeout:
        status, error = "timeout", "exceeded the time limit"
    except _PriorFailed as exc:
        status, error = "error", str(exc)
    except BaseException as exc:  # noqa: BLE001 - user code may raise anything
        status, error = "error", user_traceback(exc)
    finally:
        sys.stdin, sys.stdout, sys.stderr = old_in, old_out, old_err
        emit({
            "type": "console_done",
            "status": status,
            "error": error,
            "result": truncate(value, 20_000),
            "duration_ms": (time.perf_counter() - started) * 1000,
        })
