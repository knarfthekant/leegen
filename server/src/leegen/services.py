"""Compatibility wrapper: runs go through `ToolService.run` (leegen/service.py)."""

from __future__ import annotations

from leegen.core.models import Problem, RunResult
from leegen.state import app_state


async def run_for_user(problem: Problem, *, files: dict[str, str] | None = None,
                       executor: str | None = None, run_id: str | None = None,
                       source: str = "ui") -> RunResult:
    return await app_state().service.run(problem, files=files, executor=executor, run_id=run_id,
                                         source=source)
