"""Compiled languages. They use the `script` judge: the problem's build and command steps
compile and run a hidden harness that includes <leetclaude/judge.h> and prints result events.
Compile with `-I{bundle}/_lc/include`.
"""

from __future__ import annotations

from leetclaude.languages.base import LanguageAdapter
from leetclaude.registry import register


class _Native(LanguageAdapter):
    def harness_command(self) -> list[str]:
        raise NotImplementedError(f"{self.id} problems must use the script judge")


@register("language", "cpp")
class CppAdapter(_Native):
    id = "cpp"
    monaco = "cpp"


@register("language", "cuda")
class CudaAdapter(_Native):
    id = "cuda"
    monaco = "cpp"
