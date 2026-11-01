"""Judge kinds decide what goes into run.json and which commands run the tests."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import lookup
from leetclaude.schema.models import Problem


@dataclass
class JudgePlan:
    config: dict[str, Any]                      # merged into run.json
    command: list[str]
    build: list[list[str]] = field(default_factory=list)
    needs_ref_dir: bool = False


class JudgeKind(ABC):
    kind: str

    @abstractmethod
    def plan(self, problem: Problem, tests: list[dict[str, Any]], lang: LanguageAdapter,
             mode: str) -> JudgePlan: ...


def get_judge(kind: str) -> JudgeKind:
    return lookup("judge", kind)()
