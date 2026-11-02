"""Run a problem: plan it (core), write the bundle, pick an executor, run, assemble the result.

Planning and result assembly live in `leetclaude.core` so the browser runner shares them; this
module adds what only the native side does: a temp-dir bundle, executor choice and provisioning.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from leetclaude.core.assemble import ExecOutcome, assemble, parse_events, redact
from leetclaude.core.compat import requirements
from leetclaude.core.models import Problem, RunResult
from leetclaude.core.plan import plan_run, unique_test_name
from leetclaude.envs.provision import ProvisionError
from leetclaude.envs.registry import EnvironmentRegistry
from leetclaude.executors import ExecutorManager
from leetclaude.executors.base import JobSpec, StatusCallback, _no_status
from leetclaude.judges import get_judge
from leetclaude.languages import get_language

__all__ = ["HARNESS_DIR", "HARNESS_ROOT", "Orchestrator", "RunRequest", "parse_events", "redact",
           "unique_test_name"]

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
        requires = requirements(problem, env)
        try:
            executor = self.executors.choose(requires, req.executor, env=env)
        except LookupError as exc:
            return fail("error", str(exc))

        lang = get_language(env.language)
        device = executor.device_for(requires)
        plan = plan_run(problem, req.files, mode=req.mode, custom_tests=req.custom_tests,
                        only_visible=req.only_visible, device=device)
        jplan = get_judge(problem.judge.kind).plan(problem, plan.tests, lang, req.mode)

        bundle = Path(tempfile.mkdtemp(prefix=f"leetclaude-{problem.id}-"))
        try:
            _write_files(bundle, plan.files)
            shutil.copytree(HARNESS_DIR, bundle / "_lc" / "leetclaude_harness",
                            ignore=shutil.ignore_patterns("__pycache__"))
            shutil.copytree(HARNESS_ROOT / "include", bundle / "_lc" / "include")
            (bundle / "run.json").write_text(json.dumps(plan.run_config, indent=2))

            job_env = {**lang.harness_env(), **env.env, "LEETCLAUDE_DEVICE": device}
            if "cuda" not in executor.capabilities():
                job_env.update(env.env_without_cuda)
            if problem.limits.memory_mb:
                job_env["LEETCLAUDE_MEMORY_MB"] = str(problem.limits.memory_mb)
            job = JobSpec(run_id=run_id, bundle=bundle, command=jplan.command, build=jplan.build,
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
            result = self._assemble(run_id, problem, req, plan.tests, outcome, executor.id,
                                    device, started)
            result.duration_ms = (time.perf_counter() - t0) * 1000
            return redact(result)
        finally:
            self.active.pop(run_id, None)
            shutil.rmtree(bundle, ignore_errors=True)

    def _assemble(self, run_id: str, problem: Problem, req: RunRequest,
                  tests: list[dict[str, Any]], outcome: ExecOutcome, executor_id: str,
                  device: str, started: float) -> RunResult:
        return assemble(run_id, problem, req.mode, tests, outcome, executor_id, device, started)
