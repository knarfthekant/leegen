from __future__ import annotations

from typing import Any

from leetclaude.judges.base import JudgeKind, JudgePlan
from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register
from leetclaude.schema.models import Problem


@register("judge", "function")
class FunctionJudge(JudgeKind):
    kind = "function"

    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan:
        needs_ref = bool(problem.reference) and (
            any(t.get("needs_reference") for t in tests) or problem.benchmark is not None
        )
        return JudgePlan(
            config={
                "judge": problem.judge.model_dump(mode="json"),
                "tests": tests,
                "benchmark": problem.benchmark.model_dump() if problem.benchmark else None,
            },
            command=lang.harness_command(),
            needs_ref_dir=needs_ref,
        )
