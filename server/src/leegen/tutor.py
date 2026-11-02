"""Compatibility wrapper over `ToolService` (leegen/service.py) and `core.review`.

New code should call `app_state().service` directly.
"""

from __future__ import annotations

from typing import Any, Literal

from leegen.core.review import SEVERITIES, Severity, apply_edits  # noqa: F401
from leegen.core.review import resolve_columns as _resolve_columns  # noqa: F401
from leegen.core.models import Problem
from leegen.state import app_state


def _svc():  # type: ignore[no-untyped-def]
    return app_state().service


def current_files(problem: Problem) -> dict[str, str]:
    return _svc().current_files(problem)


def list_annotations(problem_id: str) -> list[dict[str, Any]]:
    return _svc().list_annotations(problem_id)


async def add_annotations(problem: Problem, items: list[dict[str, Any]],
                          author: str = "assistant") -> list[dict[str, Any]]:
    return await _svc().annotate(items, problem.id, author)


async def remove_annotation(problem_id: str, annotation_id: str) -> bool:
    return await _svc().remove_annotation(problem_id, annotation_id)


async def clear_annotations(problem_id: str, file: str | None = None) -> int:
    return await _svc().clear_annotations(problem_id, file)


def list_proposals(problem_id: str) -> list[dict[str, Any]]:
    return _svc().list_proposals(problem_id)


async def propose_edit(problem: Problem, file: str, *, content: str | None = None,
                       edits: list[dict[str, str]] | None = None, rationale: str = "",
                       author: str = "assistant", source: str = "mcp") -> dict[str, Any]:
    return await _svc().propose_edit(file, content=content, edits=edits, rationale=rationale,
                                     problem_id=problem.id, author=author, source=source)


async def resolve_proposal(problem: Problem, proposal_id: str,
                           action: Literal["accept", "reject"]) -> dict[str, str]:
    try:
        return await _svc().resolve_proposal(problem.id, proposal_id, action)
    except LookupError as exc:
        raise KeyError(str(exc)) from exc
