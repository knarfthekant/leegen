"""leegen.browser_runner (what the Pyodide worker calls), exercised natively."""

import json

from leegen.browser_runner import (execute, finish, parse, parse_tutorial, prepare,
                                   read_results, validate_after_reference,
                                   validate_after_starter, validate_precheck)
from leegen.envs.registry import EnvironmentRegistry
from leegen.runner.orchestrator import HARNESS_ROOT
from leegen.store.problems import ProblemStore


def _yaml(pid: str) -> str:
    return (ProblemStore().dir / f"{pid}.yaml").read_text()


def _run(tmp_path, pid: str, mode: str, files: dict | None = None, **extra) -> dict:
    req = json.dumps({"run_id": f"r-{mode}", "problem_yaml": _yaml(pid), "mode": mode,
                      "files": files or {}, **extra})
    base = str(tmp_path / mode)
    prepared = prepare(req, base)
    lines: list[str] = []
    crash = execute(base, str(HARNESS_ROOT), sink=lines.append)
    results = read_results(base)
    assert results.splitlines() == lines   # the sink sees exactly what the file gets
    out = finish(req, prepared, results, json.dumps({"exit_code": 1 if crash else 0,
                                                     "stderr": crash}))
    return json.loads(out)


def test_reference_and_starter_runs(tmp_path):
    ref = _run(tmp_path, "merge-ranges", "reference")
    assert ref["status"] == "passed" and ref["executor"] == "browser"
    hidden = [t for t in ref["tests"] if not t["visible"]]
    assert hidden and all(t["input"] is None for t in hidden)   # redacted
    starter = _run(tmp_path, "merge-ranges", "user")
    assert starter["status"] == "failed"


def test_custom_tests_take_expected_from_reference(tmp_path):
    out = _run(tmp_path, "merge-ranges", "user",
               custom_tests=[{"name": "mine", "input": {"args": [[[1, 2], [2, 3]]]}}])
    mine = next(t for t in out["tests"] if t["name"] == "mine")
    assert mine["custom"] and mine["expected"] == [[1, 3]]


def test_validation_steps_match_the_server_rules(tmp_path):
    envs = json.dumps([e.model_dump(mode="json") for e in EnvironmentRegistry().all().values()])
    yaml = _yaml("merge-ranges")
    assert json.loads(validate_precheck(yaml, envs, '["cpu"]'))["done"] is None
    ref = json.dumps(_run(tmp_path, "merge-ranges", "reference"))
    assert json.loads(validate_after_reference(yaml, ref))["done"] is None
    starter = json.dumps(_run(tmp_path, "merge-ranges", "user"))
    report = json.loads(validate_after_starter(yaml, ref, starter))
    assert report["ok"] is True and report["stage"] == "run"
    # pytorch has no browser runtime: skipped, not failed
    torch = json.loads(validate_precheck(_yaml("kv-cache-basics"), envs, '["cpu", "webgpu"]'))
    assert torch["done"]["skipped"] is True and "browser" in torch["done"]["summary"]


def test_parse_reports_schema_errors():
    good = json.loads(parse(_yaml("merge-ranges")))
    assert good["ok"] and good["public"]["id"] == "merge-ranges"
    assert "reference" not in good["public"] and good["problem"]["reference"]
    bad = json.loads(parse("id: x\n"))
    assert bad["ok"] is False and bad["stage"] == "schema"


def test_webgpu_helper_data_and_native_refusal(monkeypatch):
    monkeypatch.syspath_prepend(str(HARNESS_ROOT))
    import pytest

    from leegen_harness import webgpu as wg

    assert wg.to_f32(wg.f32([1.5, -2.0])) == [1.5, -2.0]
    assert wg.to_u32(wg.u32([7, 0])) == [7, 0] and wg.to_i32(wg.i32([-3])) == [-3]
    assert wg.groups(0, 64) == 1 and wg.groups(65, 64) == 2
    assert wg.storage(b"1234").read_only and not wg.storage(size=8).read_only
    with pytest.raises(wg.WebGPUUnavailable, match="browser edition"):
        wg.device()   # natively there is no WebGPU: a clear error, not an ImportError


def test_snippet_run_streams_output_and_echoes(tmp_path):
    solution = "def double(x):\n    return x * 2\n"
    req = json.dumps({"run_id": "r-snippet", "problem_yaml": _yaml("merge-ranges"),
                      "mode": "snippet", "files": {"solution.py": solution},
                      "snippet": {"file": "solution.py", "stdin": "",
                                  "code": "print('hi')\ndouble(21)"}})
    base = str(tmp_path / "snippet")
    prepared = prepare(req, base)
    assert json.loads(prepared)["judge"] == "snippet"
    lines: list[str] = []
    crash = execute(base, str(HARNESS_ROOT), sink=lines.append)
    results = read_results(base)
    assert results.splitlines() == lines
    assert any(json.loads(line)["type"] == "output" for line in lines)
    out = json.loads(finish(req, prepared, results, json.dumps(
        {"exit_code": 0 if not crash else 1, "stderr": crash})))
    assert out["status"] == "ok" and out["stdout"] == "hi\n" and out["result"] == "42"
    assert out["executor"] == "browser" and out["file"] == "solution.py"


TUTORIAL = """
id: demo
title: Demo
cells:
  - {type: markdown, text: hi}
  - type: code
    id: one
    starter: "x = 1"
    reference: "x = 2"
    checks:
      - {description: x is two, code: "assert x == 2"}
  - type: code
    id: two
    starter: "y = x + 1\\ny"
    reference: "y = x + 1\\ny"
    checks:
      - {description: y is three, code: "assert y == 3, 'y is wrong'"}
"""


def test_parse_tutorial_returns_full_public_and_shim_views():
    out = json.loads(parse_tutorial(TUTORIAL))
    assert out["ok"] and out["tutorial"]["id"] == "demo"
    assert "assert" not in repr(out["public"])                 # checks never reach the learner
    shim = json.loads(out["shim"])
    assert shim["id"] == "tut-demo"
    assert [f["path"] for f in shim["files"] if f["role"] == "editable"] == [
        "cells/one.py", "cells/two.py"]
    bad = json.loads(parse_tutorial("id: x\ntitle: t\ncells: []\n"))
    assert not bad["ok"] and bad["stage"] == "schema" and bad["errors"]


def test_tutorial_cell_replays_prior_cells_and_runs_checks(tmp_path):
    from leegen.core.tutorial import cell_run_inputs, parse_tutorial_yaml

    t = parse_tutorial_yaml(TUTORIAL)
    shim = json.loads(parse_tutorial(TUTORIAL))["shim"]
    files = {"cells/one.py": "x = 2", "cells/two.py": "y = x + 1\ny"}
    inputs = cell_run_inputs(t, files, "two")
    req = json.dumps({"run_id": "r-cell", "problem_yaml": shim, "files": files,
                      "mode": "snippet",
                      "snippet": {"file": None, "stdin": inputs["stdin"], "code": inputs["code"],
                                  "prior": inputs["prior"], "checks": inputs["checks"]}})
    base = str(tmp_path / "cell")
    prepared = prepare(req, base)
    crash = execute(base, str(HARNESS_ROOT))
    out = json.loads(finish(req, prepared, read_results(base), json.dumps(
        {"exit_code": 0 if not crash else 1, "stderr": crash})))
    assert out["status"] == "ok" and out["result"] == "3"
    assert [(c["description"], c["status"]) for c in out["checks"]] == [("y is three", "pass")]
