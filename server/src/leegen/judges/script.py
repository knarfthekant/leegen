from __future__ import annotations

from typing import Any

from leegen.judges.base import JudgeKind, JudgePlan
from leegen.languages.base import LanguageAdapter
from leegen.registry import register
from leegen.core.models import Problem
from leegen.core.plan import judge_config


@register("judge", "script")
class ScriptJudge(JudgeKind):
    """The problem's own harness writes result events to $LEEGEN_RESULTS.

    Commands run inside the user's files directory (`user/` in the bundle).
    """

    kind = "script"

    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan:
        assert problem.judge.command
        config, _ = judge_config(problem, tests)
        return JudgePlan(
            config=config,
            command=list(problem.judge.command),
            build=[list(c) for c in problem.judge.build],
        )
