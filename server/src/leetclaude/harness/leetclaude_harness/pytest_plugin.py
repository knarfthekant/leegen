"""pytest plugin: turns pytest reports into result events.

Config comes from env: LEETCLAUDE_VISIBLE_FILES (comma-separated test files the user can see)
and LEETCLAUDE_DEADLINE (time.monotonic() value at which the run must stop). It is read when
pytest configures the plugin, so a long-lived interpreter (Pyodide) can run many sessions.
Also runs `async def test_*` functions itself, so no pytest-asyncio is needed.
"""

from __future__ import annotations

import inspect
import os
import time
from typing import Any

import pytest

from leetclaude_harness._common import TestTimeout, alarm, run_coro
from leetclaude_harness.protocol import emit, truncate

_VISIBLE: set[str] = set()
_DEADLINE: float | None = None
_SEEN: set[str] = set()


def pytest_configure(config: Any) -> None:
    global _VISIBLE, _DEADLINE
    _VISIBLE = {p for p in os.environ.get("LEETCLAUDE_VISIBLE_FILES", "").split(",") if p}
    _DEADLINE = float(os.environ.get("LEETCLAUDE_DEADLINE", "0")) or None
    _SEEN.clear()


def _name(nodeid: str) -> str:
    return nodeid.split("::", 1)[-1].replace("::", ".")


def _section(nodeid: str) -> str | None:
    """Tests inside a class are grouped under the class name (`TestFoo::test_bar`)."""
    parts = nodeid.split("::")
    return parts[1] if len(parts) > 2 else None


def _file(nodeid: str) -> str:
    return nodeid.split("::", 1)[0]


@pytest.hookimpl(tryfirst=True)
def pytest_pyfunc_call(pyfuncitem: Any) -> bool | None:
    if inspect.iscoroutinefunction(pyfuncitem.obj):
        names = pyfuncitem._fixtureinfo.argnames
        kwargs = {n: pyfuncitem.funcargs[n] for n in names}
        run_coro(pyfuncitem.obj(**kwargs))
        return True
    return None


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_call(item: Any) -> Any:
    if _DEADLINE is None:
        yield
        return
    with alarm(max(_DEADLINE - time.monotonic(), 0.001)):
        yield


def pytest_collectreport(report: Any) -> None:
    if report.failed:
        emit({"type": "error", "message": "Collecting tests failed (does your code import?):\n"
              + truncate(str(report.longreprtext))})


def pytest_runtest_logreport(report: Any) -> None:
    if report.nodeid in _SEEN:
        return
    if report.when == "call" or (report.when == "setup" and not report.passed):
        _SEEN.add(report.nodeid)
        visible = _file(report.nodeid) in _VISIBLE
        if report.passed:
            status, message = "pass", None
        elif report.skipped:
            status, message = ("timeout", "not run: time limit reached")
        else:
            excinfo = getattr(report, "_lc_excinfo", None)
            text = str(report.longreprtext)
            if excinfo is not None and excinfo.errisinstance(TestTimeout):
                status, message = "timeout", "exceeded the time limit"
            elif excinfo is not None and excinfo.errisinstance((AssertionError, pytest.fail.Exception)):
                status, message = "fail", text
            else:
                status, message = ("error" if report.when == "setup" or excinfo else "fail"), text
        out = "\n".join(c for _, c in report.sections if c) or None
        emit({"type": "test", "name": _name(report.nodeid), "status": status, "visible": visible,
              "description": getattr(report, "_lc_doc", None),
              "section": _section(report.nodeid),
              "message": truncate(message), "stdout": truncate(out),
              "duration_ms": round(report.duration * 1000, 3)})


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item: Any, call: Any) -> Any:
    outcome = yield
    report = outcome.get_result()
    report._lc_excinfo = call.excinfo
    doc = inspect.getdoc(getattr(item, "obj", None)) if hasattr(item, "obj") else None
    report._lc_doc = doc.splitlines()[0] if doc else None


