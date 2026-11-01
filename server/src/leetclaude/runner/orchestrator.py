"""Run a problem: build the job bundle, pick an executor, run, turn events into a RunResult."""

from __future__ import annotations

import json
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from leetclaude.envs.provision import ProvisionError
from leetclaude.envs.registry import EnvironmentRegistry
from leetclaude.executors import ExecutorManager
from leetclaude.executors.base import ExecOutcome, JobSpec, StatusCallback, _no_status
from leetclaude.judges import get_judge
from leetclaude.languages import get_language
from leetclaude.schema.models import FROM_REFERENCE, Metric, Problem, RunResult, TestResult

HARNESS_ROOT = Path(__file__).resolve().parent.parent / "harness"
HARNESS_DIR = HARNESS_ROOT / "leetclaude_harness"


@dataclass
class RunRequest:
    problem: Problem
    files: dict[str, str] = field(default_factory=dict)   # editable file overrides
    mode: Literal["user", "reference"] = "user"
    executor: str | None = None
    custom_tests: list[dict[str, Any]] = field(default_factory=list)
    only_visible: bool = False


def _write_files(target: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = target / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)


def _materialize(problem: Problem, overrides: dict[str, str]) -> dict[str, str]:
    files = {f.path: f.content for f in problem.files}
    files.update({k: v for k, v in overrides.items() if (f := problem.file(k)) and f.role == "editable"})
    return files


def _reference_files(problem: Problem) -> dict[str, str]:
    assert problem.reference
    return {rf.path: rf.content for rf in problem.reference.files}


def _test_payload(problem: Problem, req: RunRequest) -> list[dict[str, Any]]:
    tests = []
    for t in problem.tests:
        if req.only_visible and not t.visible:
            continue
        tests.append({
            "name": t.name, "visible": t.visible, "custom": False,
            "input": t.input.model_dump(mode="json") if t.input else None,
            "expected": None if t.needs_reference else t.expected,
            "needs_reference": t.needs_reference,
        })
    if problem.judge.kind == "function":
        for i, ct in enumerate(req.custom_tests):
            expected = ct.get("expected", FROM_REFERENCE)
            needs_ref = expected == FROM_REFERENCE
            tests.append({
                "name": ct.get("name") or f"Custom {i + 1}", "visible": True, "custom": True,
                "input": ct.get("input") or {}, "needs_reference": needs_ref,
                "expected": None if needs_ref else expected,
            })
    return tests


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


class Orchestrator:
    def __init__(self, executors: ExecutorManager | None = None,
                 environments: EnvironmentRegistry | None = None) -> None:
        self.executors = executors or ExecutorManager()
        self.environments = environments or EnvironmentRegistry()
        self.active: dict[str, str] = {}   # run_id -> executor id

    async def cancel(self, run_id: str) -> bool:
        ex_id = self.active.get(run_id)
        ex = self.executors.get(ex_id) if ex_id else None
        return await ex.cancel(run_id) if ex else False

    async def run(self, req: RunRequest, run_id: str | None = None,
                  on_status: StatusCallback = _no_status) -> RunResult:
        problem = req.problem
        run_id = run_id or uuid.uuid4().hex[:12]
        started = time.time()
        t0 = time.perf_counter()

        def fail(status: str, error: str, executor: str = "-", **extra: Any) -> RunResult:
            return RunResult(run_id=run_id, problem_id=problem.id, mode=req.mode, status=status,
                             executor=executor, started_at=started,
                             duration_ms=(time.perf_counter() - t0) * 1000, error=error, **extra)

        env = self.environments.get(problem.environment)
        if env is None:
            return fail("error", f"unknown environment {problem.environment!r}")
        if req.mode == "reference" and not problem.reference:
            return fail("error", "problem has no reference solution")
        try:
            executor = self.executors.choose(sorted({*problem.requires, *env.requires}),
                                             req.executor)
        except LookupError as exc:
            return fail("error", str(exc))

        lang = get_language(env.language)
        judge = get_judge(problem.judge.kind)
        tests = _test_payload(problem, req)
        plan = judge.plan(problem, tests, lang, req.mode)

        bundle = Path(tempfile.mkdtemp(prefix=f"leetclaude-{problem.id}-"))
        try:
            user_files = _materialize(problem, req.files)
            if req.mode == "reference":
                user_files.update(_reference_files(problem))
            _write_files(bundle / "user", user_files)
            if plan.needs_ref_dir:
                _write_files(bundle / "ref", {**_materialize(problem, {}),
                                              **_reference_files(problem)})
            shutil.copytree(HARNESS_DIR, bundle / "_lc" / "leetclaude_harness",
                            ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(HARNESS_ROOT / "include", bundle / "_lc" / "include")
            device = executor.device_for(sorted({*problem.requires, *env.requires}))
            run_cfg = {**plan.config, "mode": req.mode, "user_dir": "user",
                       "ref_dir": "ref" if plan.needs_ref_dir else None,
                       "timeout_s": problem.limits.timeout_s, "device": device}
            (bundle / "run.json").write_text(json.dumps(run_cfg, indent=2))

            job_env = {**lang.harness_env(), **env.env, "LEETCLAUDE_DEVICE": device}
            if "cuda" not in executor.capabilities():
                job_env.update(env.env_without_cuda)
            if problem.limits.memory_mb:
                job_env["LEETCLAUDE_MEMORY_MB"] = str(problem.limits.memory_mb)
            job = JobSpec(run_id=run_id, bundle=bundle, command=plan.command, build=plan.build,
                          env=job_env, timeout_s=problem.limits.timeout_s,
                          workdir="user" if problem.judge.kind == "script" else ".")

            self.active[run_id] = executor.id
            try:
                await on_status("preparing", f"environment {env.id} on {executor.id}")
                values = await executor.prepare(env, lang.dependencies(env, problem.judge.kind))
            except ProvisionError as exc:
                return fail("error", f"could not prepare environment {env.id!r}:\n{exc}",
                            executor.id, device=device)
            outcome = await executor.run(job, values, on_status)
            result = self._assemble(run_id, problem, req, tests, outcome, executor.id, device,
                                    started)
            result.duration_ms = (time.perf_counter() - t0) * 1000
            return redact(result)
        finally:
            self.active.pop(run_id, None)
            shutil.rmtree(bundle, ignore_errors=True)

    def _assemble(self, run_id: str, problem: Problem, req: RunRequest,
                  tests: list[dict[str, Any]], outcome: ExecOutcome, executor_id: str,
                  device: str, started: float) -> RunResult:
        result = RunResult(run_id=run_id, problem_id=problem.id, mode=req.mode, status="error",
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
