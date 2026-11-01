"""Problem validation: schema + the reference must pass every test + the starter must not."""

from __future__ import annotations

from dataclasses import dataclass, field

from leetclaude.runner import Orchestrator, RunRequest
from leetclaude.schema.models import Problem, RunResult
from leetclaude.state import app_state


@dataclass
class ValidationReport:
    ok: bool
    skipped: bool = False
    summary: str = ""
    issues: list[str] = field(default_factory=list)
    reference_run: RunResult | None = None
    starter_run: RunResult | None = None

    def to_dict(self) -> dict:
        def brief(r: RunResult | None) -> dict | None:
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


async def validate_problem(problem: Problem, executor: str | None = None,
                           orchestrator: Orchestrator | None = None) -> ValidationReport:
    st = app_state()
    orch = orchestrator or st.orchestrator
    issues: list[str] = []

    env = st.environments.get(problem.environment)
    if env is None:
        known = ", ".join(sorted(st.environments.all()))
        return ValidationReport(False, issues=[f"unknown environment {problem.environment!r} "
                                               f"(known: {known})"])
    if not problem.reference:
        return ValidationReport(False, issues=["no reference solution; add `reference.files` so "
                                               "the problem can be validated"])
    requires = sorted({*problem.requires, *env.requires})
    if not st.executors.compatible(requires):
        return ValidationReport(False, skipped=True,
                                summary=f"no executor provides {requires}; not run",
                                issues=[f"configure an executor with {requires} to validate"])
    if problem.judge.kind == "function" and not any(t.visible for t in problem.tests):
        issues.append("warning: no visible tests; users won't see any example inputs")
    if problem.judge.kind == "pytest":
        visible = [p for p in problem.pytest_files() if problem.file(p).role != "hidden"]
        if not visible:
            issues.append("warning: all test files are hidden; consider a readonly test_visible.py")

    ref = await orch.run(RunRequest(problem=problem, mode="reference", executor=executor))
    if ref.status != "passed":
        issues.insert(0, f"reference solution does not pass: {ref.status} "
                         f"({ref.passed}/{ref.total})")
        for t in ref.tests:
            if t.status != "pass":
                issues.append(f"{t.name}: {t.status}: {(t.message or '').strip()[:500]}")
        if ref.error:
            issues.append(ref.error.strip()[:2000])
        return ValidationReport(False, summary=f"reference {ref.passed}/{ref.total}",
                                issues=issues, reference_run=ref)

    starter = await orch.run(RunRequest(problem=problem, mode="user", executor=executor))
    if starter.status == "passed":
        issues.append("starter code already passes every test; the problem is trivial or the "
                      "tests are too weak")
        return ValidationReport(False, summary="starter passes", issues=issues,
                                reference_run=ref, starter_run=starter)
    return ValidationReport(True, summary=f"reference {ref.passed}/{ref.total}, starter "
                                          f"{starter.passed}/{starter.total}",
                            issues=issues, reference_run=ref, starter_run=starter)
