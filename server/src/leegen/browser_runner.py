"""What the browser edition's Pyodide worker calls (web/runner/py-worker.js).

The runner page ships this module, `leegen.core` and the harness into Pyodide. A run is three
calls, so the JavaScript side can enforce wall time around the middle one (interrupt buffer,
then worker termination) and still assemble a proper result from whatever the harness emitted:

    prepare(request) -> writes the bundle under `base`, returns the planned tests
    execute(base)    -> runs the harness, like `python -m leegen_harness run.json`
    finish(...)      -> core.assemble + redact -> RunResult JSON

Validation is driven the same way (`validate_precheck` -> reference run -> `validate_after_*`).
Stdlib + `leegen.core` only; it also runs natively, which is how the tests cover it.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import traceback
from collections.abc import Callable
from typing import Any

from leegen.core import compat, validation
from leegen.core.assemble import ExecOutcome, assemble, redact
from leegen.core.events import RunnerRequest
from leegen.core.models import Environment, RunResult
from leegen.core.parse import format_error, parse_problem_yaml
from leegen.core.plan import plan_run
from leegen.core.views import public_problem

EXECUTOR_ID = "browser"


def _purge(base: str) -> None:
    """Forget modules from earlier runs: user, reference and harness modules share names."""
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None) or ""
        if (f.startswith(base) or name == "leegen_harness"
                or name.startswith("leegen_harness.")):
            del sys.modules[name]


# ------------------------------------------------------------------ runs


def prepare(request_json: str, base: str) -> str:
    req = RunnerRequest.model_validate_json(request_json)
    problem = parse_problem_yaml(req.problem_yaml)
    custom = [ct.model_dump(exclude_unset=True) for ct in req.custom_tests]
    plan = plan_run(problem, req.files, mode=req.mode, custom_tests=custom,
                    only_visible=req.only_visible, device=req.device)
    shutil.rmtree(base, ignore_errors=True)
    for rel, content in {**plan.files, "run.json": json.dumps(plan.run_config)}.items():
        path = os.path.join(base, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(content)
    return json.dumps({"tests": plan.tests, "timeout_s": problem.limits.timeout_s,
                       "judge": problem.judge.kind, "started": time.time()})


def execute(base: str, harness_root: str, sink: Callable[[str], None] | None = None,
            device: str = "cpu") -> str:
    """Run the harness on the bundle in `base`. Returns a traceback if the harness itself
    crashed (assembled as the run's stderr), else an empty string."""
    os.environ["LEEGEN_RESULTS"] = os.path.join(base, "results.jsonl")
    os.environ["LEEGEN_DEVICE"] = device
    sys.dont_write_bytecode = True
    _purge(base)
    added = harness_root not in sys.path
    if added:
        sys.path.insert(0, harness_root)
    cwd, argv = os.getcwd(), sys.argv
    os.chdir(base)
    try:
        from leegen_harness import protocol
        from leegen_harness.__main__ import main

        protocol.set_sink(sink)
        sys.argv = ["leegen_harness", os.path.join(base, "run.json")]
        main()
        return ""
    except KeyboardInterrupt:
        raise   # the runner's soft stop: the caller assembles a timeout
    except BaseException:  # noqa: BLE001 - SystemExit from pytest, crashes in the harness
        return traceback.format_exc()
    finally:
        try:
            from leegen_harness import protocol

            protocol.set_sink(None)
        except ImportError:
            pass
        os.chdir(cwd)
        sys.argv = argv
        if added and harness_root in sys.path:
            sys.path.remove(harness_root)
        _purge(base)


def read_results(base: str) -> str:
    try:
        with open(os.path.join(base, "results.jsonl"), encoding="utf-8") as fh:
            return fh.read()
    except FileNotFoundError:
        return ""


def cleanup(base: str) -> None:
    shutil.rmtree(base, ignore_errors=True)


def finish(request_json: str, prepared_json: str, results: str, outcome_json: str) -> str:
    """Assemble the RunResult. `outcome_json`: stdout, stderr, timed_out, cancelled,
    duration_ms, exit_code (what the JavaScript side observed)."""
    req = RunnerRequest.model_validate_json(request_json)
    problem = parse_problem_yaml(req.problem_yaml)
    prepared = json.loads(prepared_json)
    o = json.loads(outcome_json)
    outcome = ExecOutcome(exit_code=o.get("exit_code"), stdout=o.get("stdout", ""),
                          stderr=o.get("stderr", ""), results=results,
                          timed_out=bool(o.get("timed_out")), cancelled=bool(o.get("cancelled")),
                          duration_ms=float(o.get("duration_ms", 0.0)))
    result = assemble(req.run_id, problem, req.mode, prepared["tests"], outcome, EXECUTOR_ID,
                      req.device, prepared["started"])
    return redact(result).model_dump_json()


def error_result(request_json: str, message: str, duration_ms: str | float = 0.0) -> str:
    req = RunnerRequest.model_validate_json(request_json)
    try:
        problem_id = parse_problem_yaml(req.problem_yaml).id
    except Exception:  # noqa: BLE001
        problem_id = "?"
    return RunResult(run_id=req.run_id, problem_id=problem_id, mode=req.mode, status="error",
                     executor=EXECUTOR_ID, device=req.device, started_at=time.time(),
                     duration_ms=float(duration_ms), error=message).model_dump_json()


# ------------------------------------------------------------------ problems and validation


def parse(problem_yaml: str) -> str:
    """Schema-check a problem. {"ok", "problem" (full), "public", "errors"}."""
    try:
        p = parse_problem_yaml(problem_yaml)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"ok": False, "stage": "schema", "errors": format_error(exc)})
    return json.dumps({"ok": True, "problem": p.model_dump(mode="json"),
                       "public": public_problem(p)})


def validate_precheck(problem_yaml: str, environments_json: str, capabilities_json: str) -> str:
    """{"done": report} when validation ends before running anything, else {"done": null,
    "device": ...}. `capabilities_json`: the browser's capabilities, e.g. ["cpu", "webgpu"]."""
    capabilities = set(json.loads(capabilities_json))
    try:
        problem = parse_problem_yaml(problem_yaml)
    except Exception as exc:  # noqa: BLE001
        return json.dumps({"done": {"ok": False, "stage": "schema", "errors": format_error(exc)}})
    envs = {e["id"]: Environment.model_validate(e) for e in json.loads(environments_json)}
    env = envs.get(problem.environment)
    requires = compat.requirements(problem, env)
    runnable = env is not None and compat.can_run(capabilities, "pyodide", requires, env)
    report = validation.precheck(problem, env=env, known_envs=list(envs), runnable=runnable,
                                 requires=requires)
    if report is not None and not runnable and env is not None and problem.reference:
        report.summary = (f"{problem.environment!r} does not run in the browser edition "
                          f"(needs {requires}); not run")
        report.issues = ["validate it with the local leegen server"]
    return json.dumps({"done": {"stage": "run", **report.to_dict()} if report else None,
                       "device": compat.device_for(capabilities, requires)})


def validate_after_reference(problem_yaml: str, ref_json: str) -> str:
    problem = parse_problem_yaml(problem_yaml)
    report = validation.after_reference(problem, RunResult.model_validate_json(ref_json))
    return json.dumps({"done": {"stage": "run", **report.to_dict()} if report else None})


def validate_after_starter(problem_yaml: str, ref_json: str, starter_json: str) -> str:
    problem = parse_problem_yaml(problem_yaml)
    report = validation.after_starter(problem, RunResult.model_validate_json(ref_json),
                                      RunResult.model_validate_json(starter_json))
    return json.dumps({"stage": "run", **report.to_dict()})


def info() -> dict[str, Any]:
    return {"python": sys.version.split()[0], "platform": sys.platform}
