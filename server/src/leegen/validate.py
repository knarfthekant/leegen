"""Problem validation (CLI entry point). The rules live in `leegen.core.validation`."""

from __future__ import annotations

from leegen.core.models import Problem
from leegen.core.validation import ValidationReport
from leegen.runner import Orchestrator
from leegen.state import app_state

__all__ = ["ValidationReport", "validate_problem"]


async def validate_problem(problem: Problem, executor: str | None = None,
                           orchestrator: Orchestrator | None = None) -> ValidationReport:
    return await app_state().service.validate_problem(problem, executor, orchestrator)
