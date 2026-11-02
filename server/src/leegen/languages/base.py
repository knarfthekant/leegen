"""Language adapters: how code in a language is built and how the harness is started.

Commands are templates. Executors fill in `{python}` (the environment's interpreter) and
`{bundle}` (the job bundle path on the machine that runs it).
"""

from __future__ import annotations

from abc import ABC, abstractmethod

from leegen.registry import lookup
from leegen.schema.models import Environment


class LanguageAdapter(ABC):
    id: str
    monaco: str  # editor language id

    def dependencies(self, env: Environment, judge_kind: str) -> list[str]:
        """Packages the harness needs on top of the environment's own dependencies."""
        return []

    @abstractmethod
    def harness_command(self) -> list[str]:
        """Command that runs `python -m leegen_harness run.json` (or equivalent)."""

    def harness_env(self) -> dict[str, str]:
        return {}


def get_language(name: str) -> LanguageAdapter:
    return lookup("language", name)()
