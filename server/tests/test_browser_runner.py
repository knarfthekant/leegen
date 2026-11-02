"""leetclaude.browser_runner (what the Pyodide worker calls), exercised natively."""

import json

from leetclaude.browser_runner import (execute, finish, parse, prepare, read_results,
                                       validate_after_reference, validate_after_starter,
                                       validate_precheck)
from leetclaude.envs.registry import EnvironmentRegistry
from leetclaude.runner.orchestrator import HARNESS_ROOT
from leetclaude.store.problems import ProblemStore


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

    from leetclaude_harness import webgpu as wg

    assert wg.to_f32(wg.f32([1.5, -2.0])) == [1.5, -2.0]
    assert wg.to_u32(wg.u32([7, 0])) == [7, 0] and wg.to_i32(wg.i32([-3])) == [-3]
    assert wg.groups(0, 64) == 1 and wg.groups(65, 64) == 2
    assert wg.storage(b"1234").read_only and not wg.storage(size=8).read_only
    with pytest.raises(wg.WebGPUUnavailable, match="browser edition"):
        wg.device()   # natively there is no WebGPU: a clear error, not an ImportError
