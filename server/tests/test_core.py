"""The pure core (leegen.core), the ToolService seam and the generated contracts."""

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from leegen.config import settings
from leegen.core import compat, review
from leegen.core.models import Environment, Problem
from leegen.core.plan import plan_run
from leegen.schema.contracts import check_all, tool_manifest
from leegen.core.toolspec import TOOLS
from leegen.state import app_state
from leegen.store.problems import ProblemStore


def _env(**kw) -> Environment:
    return Environment(id="e", language="python", **kw)


def test_compat_requirements_and_runtimes():
    assert compat.satisfies({"cpu", "mps"}, ["cpu", "gpu"])
    assert not compat.satisfies({"cpu"}, ["webgpu"])
    assert compat.satisfies({"cpu", "webgpu"}, ["cpu", "webgpu"])
    native_only = _env()
    both = _env(browser={"packages": ["pytest"]})
    browser_only = _env(native=False, browser={"packages": []}, requires=["webgpu"])
    assert native_only.runtimes() == {"native"}
    assert both.runtimes() == {"native", "pyodide"}
    assert compat.can_run({"cpu"}, "native", ["cpu"], both)
    assert compat.can_run({"cpu", "webgpu"}, "pyodide", ["cpu"], both)
    assert not compat.can_run({"cpu"}, "pyodide", ["cpu"], native_only)
    assert not compat.can_run({"cpu", "cuda"}, "native", ["webgpu"], browser_only)
    assert compat.device_for({"cpu", "webgpu"}, ["webgpu"]) == "webgpu"
    assert compat.device_for({"cpu", "mps"}, ["gpu"]) == "mps"


def test_plan_run_matches_bundle_layout():
    p = ProblemStore().get("merge-ranges")
    plan = plan_run(p, {"solution.py": "x = 1\n"}, mode="user", device="cpu")
    assert plan.files["user/solution.py"] == "x = 1\n"
    assert plan.run_config["judge"]["kind"] == "function"
    assert plan.run_config["ref_dir"] == ("ref" if plan.needs_ref_dir else None)
    assert all(k.startswith(("user/", "ref/")) for k in plan.files)
    ref = plan_run(p, mode="reference")
    assert ref.files["user/solution.py"] == p.reference.files[0].content
    with pytest.raises(ValueError):
        plan_run(p.model_copy(update={"reference": None}), mode="reference")


def test_review_core_is_deterministic_with_injected_ids():
    p = ProblemStore().get("merge-ranges")
    files = {"solution.py": "def f():\n    return 1\n"}
    ids = iter(["a", "b"])
    out = review.make_annotations(p, files, [{"file": "solution.py", "start_line": 2,
                                             "message": "m"}], now=lambda: 1.0,
                                  new_id=lambda: next(ids))
    assert out == [{"id": "a", "file": "solution.py", "start_line": 2, "end_line": 2,
                    "start_col": 5, "end_col": 13, "severity": "info", "message": "m",
                    "author": "assistant", "created_at": 1.0}]


def test_browser_only_environment_is_refused_by_native_executors():
    st = app_state()
    env = _env(native=False, browser={"packages": []}, requires=["webgpu"])
    assert st.executors.compatible(["webgpu"], env) == []
    with pytest.raises(LookupError, match="browser edition"):
        st.executors.choose(["webgpu"], env=env)


def test_rest_and_service_parity():
    client = TestClient(app_state_app())
    assert client.get("/api/problems/nope").status_code == 404
    r = client.post("/api/workspace/merge-ranges/custom_tests", json={"args": [[[5, 6]]]})
    assert r.status_code == 200 and r.json()["custom_tests"] >= 1
    bad = client.post("/api/workspace/merge-ranges/custom_tests",
                      json={"args": [[]], "section": "nope"})
    assert bad.status_code == 400 and "unknown section" in bad.json()["detail"]
    client.post("/api/session", json={"problem_id": "merge-ranges"})
    assert client.get("/api/session").json()["problem_id"] == "merge-ranges"
    assert client.delete("/api/workspace/merge-ranges/annotations").json()["removed"] >= 0
    assert client.post("/api/workspace/merge-ranges/proposals/zz/accept").status_code == 404
    assert client.post("/api/workspace/merge-ranges/proposals/zz/maybe").status_code == 400
    ex = client.get("/api/executors", params={"problem_id": "merge-ranges"}).json()
    assert ex["runtimes"] == ["native", "pyodide"] and ex["executors"][0]["runtime"] == "native"


def app_state_app():
    from leegen.app import create_app

    return create_app(watch=False)


def test_tool_manifest_covers_toolspec():
    manifest = tool_manifest()
    names = {t["name"] for t in manifest["tools"]}
    assert names == set(TOOLS)
    session = next(t for t in manifest["tools"] if t["name"] == "get_session")
    assert session["annotations"]["readOnlyHint"] is True
    delete = next(t for t in manifest["tools"] if t["name"] == "delete_problem")
    assert delete["annotations"]["consequentialHint"] is True


def test_generated_contracts_are_up_to_date():
    # tests run against copies of problems/, but contracts come from the repo's own files
    stale = [str(p.relative_to(settings().root)) for p in check_all()]
    assert stale == [], f"run `uv run leegen schema`: {stale}"


def test_run_coro_outside_a_loop(monkeypatch):
    from leegen.runner.orchestrator import HARNESS_ROOT

    monkeypatch.syspath_prepend(str(HARNESS_ROOT))   # the bundle's _lc/ on PYTHONPATH
    from leegen_harness._common import run_coro

    async def three() -> int:
        await asyncio.sleep(0)
        return 3

    assert run_coro(three()) == 3


def test_problem_schema_accepts_webgpu_requirement():
    data = json.loads((settings().root / "schema" / "problem.schema.json").read_text())
    assert "webgpu" in json.dumps(data["properties"]["requires"])
    assert Problem.model_fields["requires"]
