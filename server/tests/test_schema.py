import pytest
import yaml
from pydantic import ValidationError

from leegen.schema.export import problem_json_schema
from leegen.schema.models import Problem
from leegen.schema.views import public_problem
from leegen.store.problems import ProblemStore, dump_problem_yaml, parse_problem_yaml


def test_seed_problems_load():
    store = ProblemStore()
    assert store.errors() == []
    ids = {p.id for p in store.list()}
    assert ids == {"merge-ranges", "iterators-and-await", "kv-cache-basics",
                   "cuda-vector-add", "webgpu-tiled-matmul"}


def test_yaml_round_trip():
    for p in ProblemStore().list():
        again = parse_problem_yaml(dump_problem_yaml(p))
        assert again == p


def base(**over):
    data = {
        "id": "x-problem", "title": "X", "environment": "python", "description": "d",
        "files": [{"path": "solution.py", "content": "def f(x):\n    pass\n"}],
        "judge": {"kind": "function", "entry": "solution.py:f"},
        "tests": [{"name": "t", "input": {"args": [1]}, "expected": 1}],
    }
    data.update(over)
    return data


def test_minimal_problem_is_valid():
    Problem.model_validate(base())


@pytest.mark.parametrize("over,needle", [
    ({"id": "Bad Id"}, "id"),
    ({"files": [{"path": "../x.py", "content": ""}]}, "relative"),
    ({"files": [{"path": "s.py", "role": "readonly", "content": ""}]}, "editable"),
    ({"judge": {"kind": "function"}}, "entry"),
    ({"judge": {"kind": "function", "entry": "missing.py:f"}}, "not in files"),
    ({"tests": [{"name": "t", "input": {"args": [1]}}]}, "reference"),
    ({"tests": [{"name": "t", "input": {}, "expected": 1}, {"name": "t", "input": {}, "expected": 1}]},
     "duplicate test"),
    ({"judge": {"kind": "pytest"}}, "test files"),
    ({"unknown_field": 1}, "extra"),
])
def test_invalid_problems_rejected(over, needle):
    with pytest.raises(ValidationError) as exc:
        Problem.model_validate(base(**over))
    assert needle.lower() in str(exc.value).lower()


def test_public_view_hides_secrets():
    p = ProblemStore().get("merge-ranges")
    view = public_problem(p)
    assert "reference" not in view
    assert all(f["role"] != "hidden" for f in view["files"])
    hidden = [t for t in view["tests"] if not t["visible"]]
    assert hidden and all("input" not in t for t in hidden)


def test_json_schema_exports():
    schema = problem_json_schema()
    assert schema["title"] == "Problem"
    assert "judge" in schema["properties"]
    yaml.safe_dump(schema)


def test_sections_round_trip_and_validate():
    data = base(
        sections=[{"id": "basics", "title": "Basics", "description": "d"}, {"id": "edge", "title": "Edge"}],
        tests=[{"name": "a", "section": "basics", "description": "x", "input": {"args": [1]}, "expected": 1},
               {"name": "b", "input": {"args": [2]}, "expected": 2}],
    )
    p = Problem.model_validate(data)
    assert parse_problem_yaml(dump_problem_yaml(p)) == p
    view = public_problem(p)
    assert [s["id"] for s in view["sections"]] == ["basics", "edge"]
    assert view["tests"][0]["section"] == "basics" and view["tests"][1]["section"] is None


@pytest.mark.parametrize("over,needle", [
    ({"tests": [{"name": "a", "section": "nope", "input": {"args": [1]}, "expected": 1}]}, "unknown section"),
    ({"sections": [{"id": "a", "title": "A"}, {"id": "a", "title": "B"}]}, "duplicate section"),
    ({"sections": [{"id": "Bad Id", "title": "A"}]}, "id"),
])
def test_invalid_sections_rejected(over, needle):
    with pytest.raises(ValidationError) as exc:
        Problem.model_validate(base(**over))
    assert needle.lower() in str(exc.value).lower()


def test_seed_problem_without_sections_still_loads():
    p = ProblemStore().get("kv-cache-basics")
    assert p is not None and p.sections == [] and all(t.section is None for t in p.tests)
