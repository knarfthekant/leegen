from __future__ import annotations

from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register
from leetclaude.schema.models import Environment


@register("language", "python")
class PythonAdapter(LanguageAdapter):
    id = "python"
    monaco = "python"

    def dependencies(self, env: Environment, judge_kind: str) -> list[str]:
        has_pytest = any(d.split("[")[0].split("=")[0].split(">")[0].split("<")[0].strip() == "pytest"
                         for d in env.dependencies)
        return [] if has_pytest else ["pytest"]

    def harness_command(self) -> list[str]:
        return ["{python}", "-B", "-m", "leetclaude_harness", "run.json"]

    def harness_env(self) -> dict[str, str]:
        return {"PYTHONPATH": "{bundle}/_lc", "PYTHONDONTWRITEBYTECODE": "1",
                "PYTHONUNBUFFERED": "1"}
