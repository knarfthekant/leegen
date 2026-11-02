from __future__ import annotations

from typing import Any

from leegen.judges.base import JudgeKind, JudgePlan
from leegen.languages.base import LanguageAdapter
from leegen.registry import register
from leegen.core.models import Problem
from leegen.core.plan import judge_config


@register("judge", "pytest")
class PytestJudge(JudgeKind):
    kind = "pytest"

    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan:
        config, _ = judge_config(problem, tests)
        return JudgePlan(config=config, command=lang.harness_command())
