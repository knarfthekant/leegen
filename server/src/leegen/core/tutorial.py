"""Tutorials: one notebook-like page of Markdown cells and runnable code cells.

A tutorial is a single YAML file (`tutorials/<id>.yaml`). Code cells run in order inside one
shared namespace, like a notebook, but nothing is a live kernel: running cell N replays the
learner's current code for cells 1..N-1 silently, runs cell N with its output captured, then runs
the cell's hidden `checks`. The checks and the reference are never sent to the learner; a check's
result appears only after the cell has run.

Each code cell is stored as one editable file of a shim `Problem` (`shim_problem`), so the
existing workspace stores (server and browser) keep the learner's code without new machinery.

Part of `leegen.core`: stdlib + pydantic + pyyaml only, so it also runs inside Pyodide.
"""

from __future__ import annotations

from typing import Annotated, Any, Literal

import yaml
from pydantic import Field, model_validator

from leegen.core.models import Problem, ProblemFile, Judge, _Strict

SLUG = r"^[a-z0-9][a-z0-9-]{0,40}$"
SHIM_PREFIX = "tut-"
MAX_CHECKS_PER_CELL = 40


class Check(_Strict):
    description: str = Field(description="One line saying what is verified. Shown after the run.")
    code: str = Field(
        description="Python run in the cell's namespace after the learner's code. The check "
        "passes when it raises nothing; `assert` is the normal way to fail. Never shown "
        "before the run, so it may spell out the expected answer."
    )


class MarkdownCell(_Strict):
    type: Literal["markdown"] = "markdown"
    text: str = Field(description="Markdown with math, mermaid, inline SVG and directives.")


class CodeCell(_Strict):
    type: Literal["code"] = "code"
    id: str = Field(pattern=SLUG, description="Slug, unique inside the tutorial.")
    starter: str = Field("", description="What the learner sees first: a stub, a TODO, or a demo.")
    reference: str | None = Field(
        None, description="A correct version of the cell. Required when the cell has checks; "
        "validation replays it to prove the checks pass, and that the starter fails them.")
    checks: list[Check] = Field(default_factory=list, max_length=MAX_CHECKS_PER_CELL)
    stdin: str = Field("", description="Text that `input()` reads, one line per call.")


Cell = Annotated[MarkdownCell | CodeCell, Field(discriminator="type")]


class Tutorial(_Strict):
    schema_version: Literal[1] = 1
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,56}$", description="Slug; also the file name.")
    title: str
    summary: str = Field("", description="One line for the list page.")
    tags: list[str] = Field(default_factory=list)
    environment: str = Field("python", description="A Python environment from `environments/`.")
    track: str | None = None
    order: int | None = None
    cells: list[Cell] = Field(min_length=1)

    @model_validator(mode="after")
    def _consistency(self) -> Tutorial:
        ids = [c.id for c in self.cells if isinstance(c, CodeCell)]
        if not ids:
            raise ValueError("a tutorial needs at least one code cell")
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate code cell ids")
        for c in self.cells:
            if isinstance(c, CodeCell) and c.checks and c.reference is None:
                raise ValueError(f"cell {c.id!r} has checks but no reference")
        return self

    def code_cells(self) -> list[CodeCell]:
        return [c for c in self.cells if isinstance(c, CodeCell)]


def cell_path(cell_id: str) -> str:
    """The workspace file that holds one code cell."""
    return f"cells/{cell_id}.py"


def shim_id(tutorial_id: str) -> str:
    return SHIM_PREFIX + tutorial_id


def shim_problem(t: Tutorial) -> Problem:
    """A stand-in `Problem` so workspaces, runners and the console see a tutorial as files.

    Each code cell is an editable file seeded with its starter. A hidden empty test file keeps
    the pytest judge valid; it is never run, because tutorials only use the snippet pipeline.
    """
    files = [ProblemFile(path=cell_path(c.id), role="editable", content=c.starter)
             for c in t.code_cells()]
    files.append(ProblemFile(path="test_tutorial.py", role="hidden", content=""))
    return Problem(id=shim_id(t.id), title=t.title, environment=t.environment, difficulty="intro",
                   tags=t.tags, description=t.summary or t.title, files=files,
                   judge=Judge(kind="pytest"))


def cell_run_inputs(t: Tutorial, files: dict[str, str], cell_id: str) -> dict[str, Any]:
    """What the snippet runner needs to run `cell_id` after the cells before it."""
    prior: list[str] = []
    for c in t.code_cells():
        code = files.get(cell_path(c.id), c.starter)
        if c.id == cell_id:
            return {"code": code, "prior": prior, "stdin": c.stdin,
                    "checks": [ck.model_dump() for ck in c.checks]}
        prior.append(code)
    raise ValueError(f"unknown cell {cell_id!r}")


def reference_files(t: Tutorial) -> dict[str, str]:
    return {cell_path(c.id): (c.reference if c.reference is not None else c.starter)
            for c in t.code_cells()}


def public_tutorial(t: Tutorial) -> dict[str, Any]:
    """What the learner may see: no reference, no checks (only whether a cell has any)."""
    cells: list[dict[str, Any]] = []
    for c in t.cells:
        if isinstance(c, MarkdownCell):
            cells.append({"type": "markdown", "text": c.text})
        else:
            cells.append({"type": "code", "id": c.id, "starter": c.starter,
                          "path": cell_path(c.id), "has_checks": bool(c.checks),
                          "stdin": c.stdin})
    return {"id": t.id, "title": t.title, "summary": t.summary, "tags": t.tags,
            "environment": t.environment, "track": t.track, "order": t.order, "cells": cells}


def tutorial_summary(t: Tutorial) -> dict[str, Any]:
    code = t.code_cells()
    return {"id": t.id, "title": t.title, "summary": t.summary, "tags": t.tags,
            "environment": t.environment, "track": t.track, "order": t.order,
            "cells": len(code), "checked": sum(1 for c in code if c.checks)}


# ------------------------------------------------------------------ YAML


def parse_tutorial_yaml(text: str) -> Tutorial:
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError("tutorial YAML must be a mapping at the top level")
    return Tutorial.model_validate(data)
