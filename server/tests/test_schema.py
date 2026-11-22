import json

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
                   "cuda-vector-add", "webgpu-tiled-matmul", "counter-and-defaultdict",
                   "deque-operations", "heapq-operations", "lru-cache-design"}


def test_no_seed_problem_is_intro():
    # introductions are tutorials now, not a difficulty level
    assert all(p.difficulty != "intro" for p in ProblemStore().list())


def test_yaml_round_trip():
    for p in ProblemStore().list():
        again = parse_problem_yaml(dump_problem_yaml(p))
        assert again == p


def base(**over):
    data = {
        "id": "x-problem", "title": "X", "environment": "python", "description": "d",
        "files": [{"path": "solution.py", "content": "def f(x):\n    pass\n"}],
        "judge": {"kind": "function", "entry": "solution.py:f"},
        "sections": [{"id": "g", "title": "G", "description": "What the group checks."}],
        "tests": [{"name": "t", "section": "g", "input": {"args": [1]}, "expected": 1}],
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
    ({"tests": [{"name": "t", "section": "g", "input": {"args": [1]}}]}, "reference"),
    ({"tests": [{"name": "t", "section": "g", "input": {}, "expected": 1},
                {"name": "t", "section": "g", "input": {}, "expected": 1}]}, "duplicate test"),
    ({"judge": {"kind": "pytest"}}, "test files"),
    ({"unknown_field": 1}, "extra"),
    ({"difficulty": "intro"}, "difficulty"),
    ({"tests": [{"name": "t", "input": {"args": [1]}, "expected": 1}]}, "section"),
    ({"sections": [], "tests": [{"name": "t", "section": "g", "input": {}, "expected": 1}]},
     "requires `sections`"),
    ({"tests": [{"name": "t", "section": "g", "description": "per-test text",
                 "input": {"args": [1]}, "expected": 1}]}, "description"),
    ({"judge": {"kind": "script", "command": ["./run"]}, "sections": [], "tests": []},
     "requires `sections`"),
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
        sections=[{"id": "basics", "title": "Basics", "description": "d"},
                  {"id": "edge", "title": "Edge", "description": "e"}],
        tests=[{"name": "a", "section": "basics", "input": {"args": [1]}, "expected": 1},
               {"name": "b", "section": "edge", "input": {"args": [2]}, "expected": 2}],
    )
    p = Problem.model_validate(data)
    assert parse_problem_yaml(dump_problem_yaml(p)) == p
    view = public_problem(p)
    assert [s["id"] for s in view["sections"]] == ["basics", "edge"]
    assert [t["section"] for t in view["tests"]] == ["basics", "edge"]
    assert all("description" not in t for t in view["tests"])


@pytest.mark.parametrize("over,needle", [
    ({"tests": [{"name": "a", "section": "nope", "input": {"args": [1]}, "expected": 1}]}, "unknown section"),
    ({"sections": [{"id": "g", "title": "A", "description": "a"},
                   {"id": "g", "title": "B", "description": "b"}]}, "duplicate section"),
    ({"sections": [{"id": "Bad Id", "title": "A", "description": "a"}]}, "id"),
    ({"sections": [{"id": "g", "title": "A"}]}, "description"),
    ({"sections": [{"id": "g", "title": "A", "description": ""}]}, "description"),
])
def test_invalid_sections_rejected(over, needle):
    with pytest.raises(ValidationError) as exc:
        Problem.model_validate(base(**over))
    assert needle.lower() in str(exc.value).lower()


def test_every_seed_test_belongs_to_a_described_group():
    for p in ProblemStore().list():
        if p.judge.kind == "pytest":
            continue
        assert p.sections, p.id
        assert all(sec.description for sec in p.sections), p.id
        assert all(t.section for t in p.tests), p.id


def test_pytest_grouping_is_mandatory_and_docstring_backed():
    from leegen.core.validation import grouping_errors

    def problem(test_source: str):
        return parse_problem_yaml(f"""
schema_version: 1
id: x-pytest
title: X
environment: python
description: d
files:
- {{path: solution.py, content: "def f():\\n    pass\\n"}}
- {{path: test_visible.py, role: readonly, content: {json.dumps(test_source)}}}
reference:
  files:
  - {{path: solution.py, content: "def f():\\n    return 1\\n"}}
judge: {{kind: pytest}}
""")

    loose = grouping_errors(problem(
        "def test_a():\n    assert True\n\ndef test_b():\n    assert True\n"))
    assert any("class Test<Thing>" in i and "test_a" in i for i in loose)

    undocumented = grouping_errors(problem(
        "class TestF:\n    def test_a(self):\n        assert True\n"))
    assert any("TestF needs a docstring" in i for i in undocumented)

    tidy = grouping_errors(problem(
        'class TestF:\n    """What F does."""\n\n    def test_a(self):\n        assert True\n'))
    assert tidy == []
