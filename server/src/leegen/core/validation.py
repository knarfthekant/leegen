"""Problem validation: the reference must pass every test and the starter must not.

Runner-agnostic: the caller passes `run(mode)`, so the server uses its orchestrator and the
browser runner uses Pyodide, with the same rules and the same report.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from leegen.core.models import Environment, Problem, RunResult

RunFn = Callable[[str], Awaitable[RunResult]]


@dataclass
class ValidationReport:
    ok: bool
    skipped: bool = False
    summary: str = ""
    issues: list[str] = field(default_factory=list)
    reference_run: RunResult | None = None
    starter_run: RunResult | None = None

    def to_dict(self) -> dict[str, Any]:
        def brief(r: RunResult | None) -> dict[str, Any] | None:
            if r is None:
                return None
            return {"status": r.status, "passed": r.passed, "total": r.total,
                    "executor": r.executor, "device": r.device, "error": r.error,
                    "failing": [{"name": t.name, "status": t.status, "message": t.message,
                                 "expected": t.expected, "actual": t.actual}
                                for t in r.tests if t.status != "pass"]}

        return {"ok": self.ok, "skipped": self.skipped, "summary": self.summary,
                "issues": self.issues, "reference_run": brief(self.reference_run),
                "starter_run": brief(self.starter_run)}


def static_issues(problem: Problem) -> list[str]:
    issues = []
    if problem.judge.kind == "function" and not any(t.visible for t in problem.tests):
        issues.append("warning: no visible tests; users won't see any example inputs")
    if problem.judge.kind == "pytest":
        visible = [p for p in problem.pytest_files()
                   if (f := problem.file(p)) is not None and f.role != "hidden"]
        if not visible:
            issues.append("warning: all test files are hidden; consider a readonly test_visible.py")
    return issues


def precheck(problem: Problem, *, env: Environment | None, known_envs: list[str],
             runnable: bool, requires: list[str]) -> ValidationReport | None:
    """A final report when the problem can't be run at all, else None (go run the reference)."""
    if env is None:
        return ValidationReport(False, issues=[f"unknown environment {problem.environment!r} "
                                               f"(known: {', '.join(sorted(known_envs))})"])
    if not problem.reference:
        return ValidationReport(False, issues=["no reference solution; add `reference.files` so "
                                               "the problem can be validated"])
    if not runnable:
        return ValidationReport(False, skipped=True,
                                summary=f"no executor provides {requires}; not run",
                                issues=[f"configure an executor with {requires} to validate"])
    return None


def after_reference(problem: Problem, ref: RunResult) -> ValidationReport | None:
    """A failure report if the reference doesn't pass, else None (go run the starter)."""
    if ref.status == "passed":
        return None
    issues = static_issues(problem)
    issues.insert(0, f"reference solution does not pass: {ref.status} ({ref.passed}/{ref.total})")
    for t in ref.tests:
        if t.status != "pass":
            issues.append(f"{t.name}: {t.status}: {(t.message or '').strip()[:500]}")
    if ref.error:
        issues.append(ref.error.strip()[:2000])
    return ValidationReport(False, summary=f"reference {ref.passed}/{ref.total}",
                            issues=issues, reference_run=ref)


def after_starter(problem: Problem, ref: RunResult, starter: RunResult) -> ValidationReport:
    issues = static_issues(problem)
    if starter.status == "passed":
        issues.append("starter code already passes every test; the problem is trivial or the "
                      "tests are too weak")
        return ValidationReport(False, summary="starter passes", issues=issues,
                                reference_run=ref, starter_run=starter)
    return ValidationReport(True, summary=f"reference {ref.passed}/{ref.total}, starter "
                                          f"{starter.passed}/{starter.total}",
                            issues=issues, reference_run=ref, starter_run=starter)


async def validate(problem: Problem, *, env: Environment | None, known_envs: list[str],
                   runnable: bool, requires: list[str], run: RunFn) -> ValidationReport:
    """precheck -> reference run -> starter run. The browser runner drives the same three
    steps itself, so each run gets its own deadline."""
    report = precheck(problem, env=env, known_envs=known_envs, runnable=runnable,
                      requires=requires)
    if report is not None:
        return report
    ref = await run("reference")
    report = after_reference(problem, ref)
    if report is not None:
        return report
    return after_starter(problem, ref, await run("user"))
