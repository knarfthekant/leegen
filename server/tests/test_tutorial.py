"""Tutorials: schema rules, the learner's public view, and notebook-mode cell runs."""

from __future__ import annotations

import pytest

from leegen.core.tutorial import (cell_run_inputs, parse_tutorial_yaml, public_tutorial,
                                  shim_problem)
from leegen.envs.registry import EnvironmentRegistry
from leegen.executors import ExecutorManager
from leegen.runner import Orchestrator, SnippetRequest

YAML = """
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
      - {description: boom, code: "raise KeyError('k')"}
      - {description: y is three, code: "assert y == 3, 'y is wrong'"}
"""

tut = parse_tutorial_yaml(YAML)
orch = Orchestrator(ExecutorManager(), EnvironmentRegistry())


async def run(cell: str, files: dict[str, str] | None = None):
    inputs = cell_run_inputs(tut, files or {}, cell)
    return await orch.run_snippet(SnippetRequest(problem=shim_problem(tut), files=files or {},
                                                 **inputs))


def test_public_view_hides_checks_and_reference():
    pub = public_tutorial(tut)
    blob = repr(pub)
    assert "assert" not in blob and "reference" not in blob
    code = [c for c in pub["cells"] if c["type"] == "code"]
    assert code[0]["has_checks"] and code[0]["starter"] == "x = 1"


def test_checks_need_a_reference_and_ids_are_unique():
    with pytest.raises(ValueError, match="no reference"):
        parse_tutorial_yaml("id: bad\ntitle: t\ncells:\n- {type: code, id: a, "
                            "checks: [{description: d, code: 'pass'}]}\n")
    with pytest.raises(ValueError, match="duplicate"):
        parse_tutorial_yaml("id: bad\ntitle: t\ncells:\n- {type: code, id: a}\n"
                            "- {type: code, id: a}\n")


async def test_cell_replays_earlier_cells_and_reports_checks():
    files = {"cells/one.py": "x = 2", "cells/two.py": "y = x + 1\ny"}
    r = await run("two", files)
    assert r.status == "ok" and r.result == "3" and r.stdout == ""
    assert [(c.description, c.status) for c in r.checks] == [("boom", "error"),
                                                             ("y is three", "pass")]
    assert r.checks[0].message.startswith("KeyError")


async def test_failed_assert_message_and_earlier_cell_output_is_muted():
    files = {"cells/one.py": 'print("noisy")\nx = 5', "cells/two.py": "y = x"}
    r = await run("two", files)
    assert r.stdout == "" and r.checks[1].status == "fail" and r.checks[1].message == "y is wrong"


async def test_earlier_cell_failure_names_the_cell_and_skips_checks():
    r = await run("two", {"cells/one.py": "raise ValueError('nope')"})
    assert r.status == "error" and "code cell 1" in r.error and "nope" in r.error
    assert r.checks == []
