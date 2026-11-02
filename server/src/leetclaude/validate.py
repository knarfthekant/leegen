"""Problem validation (CLI entry point). The rules live in `leetclaude.core.validation`."""

from __future__ import annotations

from leetclaude.core.models import Problem
from leetclaude.core.validation import ValidationReport
from leetclaude.runner import Orchestrator
from leetclaude.state import app_state

__all__ = ["ValidationReport", "validate_problem"]


async def validate_problem(problem: Problem, executor: str | None = None,
                           orchestrator: Orchestrator | None = None) -> ValidationReport:
    return await app_state().service.validate_problem(problem, executor, orchestrator)
