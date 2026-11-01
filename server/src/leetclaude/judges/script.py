from __future__ import annotations

from typing import Any

from leetclaude.judges.base import JudgeKind, JudgePlan
from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register
from leetclaude.schema.models import Problem


@register("judge", "script")
class ScriptJudge(JudgeKind):
    """The problem's own harness writes result events to $LEETCLAUDE_RESULTS.

    Commands run inside the user's files directory (`user/` in the bundle).
    """

    kind = "script"

    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan:
        assert problem.judge.command
        return JudgePlan(
            config={"judge": problem.judge.model_dump(mode="json"), "tests": tests},
            command=list(problem.judge.command),
            build=[list(c) for c in problem.judge.build],
        )
