"""Turn what an executor produced (harness JSONL + process facts) into a RunResult."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from leegen.core.models import (ConsoleResult, ConsoleStatus, Metric, Problem, RunResult,
                                TestResult)


@dataclass
class ExecOutcome:
    exit_code: int | None
    stdout: str = ""
    stderr: str = ""
    results: str = ""                 # raw JSONL written by the harness
    timed_out: bool = False
    cancelled: bool = False
    build_failed: bool = False
    build_output: str = ""
    duration_ms: float = 0.0


def parse_events(raw: str) -> list[dict[str, Any]]:
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            events.append({"type": "log", "message": line})
    return events


def redact(result: RunResult) -> RunResult:
    """Hidden tests that pass show only name + status. Failures reveal their data (training tool)."""
    for t in result.tests:
        if not t.visible and t.status == "pass":
            t.input = t.expected = t.actual = None
    return result


MAX_CONSOLE_OUTPUT = 200_000


def _cap(text: str, limit: int = MAX_CONSOLE_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... (output truncated at {limit} characters)"


def assemble_console(run_id: str, problem: Problem, outcome: ExecOutcome, executor_id: str,
                     device: str, started: float, *, file: str | None = None) -> ConsoleResult:
    """Console results come from `output` and `console_done` events, never from `assemble()`."""
    stdout: list[str] = []
    stderr: list[str] = []
    done: dict[str, Any] | None = None
    for ev in parse_events(outcome.results):
        kind = ev.get("type")
        if kind == "output":
            text = str(ev.get("text") or "")
            (stderr if ev.get("stream") == "stderr" else stdout).append(text)
        elif kind == "console_done":
            done = ev

    status: ConsoleStatus = "ok"
    error: str | None = None
    value: str | None = None
    if outcome.cancelled:
        status = "cancelled"
    elif done is not None:
        status = done.get("status") or "error"  # type: ignore[assignment]
        error = done.get("error")
        value = done.get("result")
    elif outcome.timed_out:
        status = "timeout"
    elif outcome.exit_code not in (0, None):
        status = "error"
        error = (outcome.stderr.strip()[-4000:] or
                 f"process exited with code {outcome.exit_code}")
    else:
        status = "error"
        error = outcome.stderr.strip()[-4000:] or "the console produced no result"

    if outcome.stderr.strip() and done is not None and status == "ok":
        # harness-level noise (imports, warnings) alongside a successful run
        stderr.append(outcome.stderr)
    elif outcome.stderr.strip() and status != "ok" and not stderr:
        stderr.append(outcome.stderr)

    return ConsoleResult(
        run_id=run_id, problem_id=problem.id, status=status, executor=executor_id,
        device=device, file=file, started_at=started,
        duration_ms=outcome.duration_ms, stdout=_cap("".join(stdout)),
        stderr=_cap("".join(stderr)), result=value, error=error,
    )


def assemble(run_id: str, problem: Problem, mode: str, tests: list[dict[str, Any]],
             outcome: ExecOutcome, executor_id: str, device: str, started: float) -> RunResult:
    result = RunResult(run_id=run_id, problem_id=problem.id, mode=mode, status="error",
                       executor=executor_id, device=device, started_at=started,
                       duration_ms=outcome.duration_ms, stdout=outcome.stdout,
                       stderr=outcome.stderr)
    if outcome.cancelled:
        result.status = "cancelled"
        return result
    if outcome.build_failed:
        result.status = "compile_error"
        result.compile_output = outcome.build_output
        return result
    if outcome.build_output:
        result.compile_output = outcome.build_output

    errors: list[str] = []
    by_name: dict[str, TestResult] = {}
    for ev in parse_events(outcome.results):
        kind = ev.get("type")
        if kind == "test":
            fields = {k: ev.get(k) for k in TestResult.model_fields if k in ev}
            by_name[ev["name"]] = TestResult(**fields)
        elif kind == "metric":
            result.metrics.append(Metric(**{k: ev[k] for k in Metric.model_fields if k in ev}))
        elif kind in ("error", "compile_error"):
            errors.append(ev.get("message", ""))
            if kind == "compile_error":
                result.compile_output = (result.compile_output or "") + ev.get("message", "")

    # every expected test gets a result, even if the process died before reaching it
    ordered: list[TestResult] = []
    for t in tests:
        if t["name"] in by_name:
            ordered.append(by_name.pop(t["name"]))
        else:
            reason = ("time limit reached" if outcome.timed_out else
                      (errors[0].splitlines()[0] if errors else
                       f"process exited (code {outcome.exit_code}) before this test ran"))
            ordered.append(TestResult(
                name=t["name"], visible=t.get("visible", True), custom=t.get("custom", False),
                description=t.get("description"), section=t.get("section"),
                status="timeout" if outcome.timed_out else "error", message=reason))
    ordered.extend(by_name.values())  # pytest/script tests aren't declared up front
    result.tests = ordered
    result.total = len(ordered)
    result.passed = sum(t.status == "pass" for t in ordered)
    result.error = "\n\n".join(errors) or None

    if any(e for e in errors) and result.total == 0:
        result.status = "error"
    elif outcome.timed_out and result.passed < result.total:
        result.status = "timeout"
    elif result.total == 0:
        result.status = "error"
        result.error = result.error or (
            f"no test results were produced (exit code {outcome.exit_code})\n"
            + outcome.stderr[-4000:])
    elif result.passed == result.total and not errors:
        result.status = "passed"
    else:
        result.status = "failed"
    return result
