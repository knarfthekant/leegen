from __future__ import annotations

from typing import Any

from leetclaude.judges.base import JudgeKind, JudgePlan
from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register
from leetclaude.core.models import Problem
from leetclaude.core.plan import judge_config


@register("judge", "script")
class ScriptJudge(JudgeKind):
    """The problem's own harness writes result events to $LEETCLAUDE_RESULTS.

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
