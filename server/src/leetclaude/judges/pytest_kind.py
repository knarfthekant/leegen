from __future__ import annotations

from typing import Any

from leetclaude.judges.base import JudgeKind, JudgePlan
from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register
from leetclaude.schema.models import Problem


@register("judge", "pytest")
class PytestJudge(JudgeKind):
    kind = "pytest"

    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan:
        files = problem.pytest_files()
        visible = [p for p in files if (f := problem.file(p)) and f.role != "hidden"]
        return JudgePlan(
            config={"judge": problem.judge.model_dump(mode="json"), "test_files": files,
                    "visible_files": visible},
            command=lang.harness_command(),
        )
