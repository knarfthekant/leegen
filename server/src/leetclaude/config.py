"""Paths and settings. Everything is overridable with LEETCLAUDE_* environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _default_root() -> Path:
    # server/src/leetclaude/config.py -> repo root is three levels above the package dir
    return Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    root: Path
    problems_dir: Path
    environments_dir: Path
    workspace_dir: Path
    cache_dir: Path
    executors_file: Path
    package_index: str

    @property
    def docs_dir(self) -> Path:
        return self.root / "docs"

    @property
    def web_dist(self) -> Path:
        return self.root / "web" / "dist"


@lru_cache
def settings() -> Settings:
    root = Path(os.environ.get("LEETCLAUDE_ROOT", _default_root())).resolve()
    return Settings(
        root=root,
        problems_dir=Path(os.environ.get("LEETCLAUDE_PROBLEMS", root / "problems")),
        environments_dir=Path(os.environ.get("LEETCLAUDE_ENVIRONMENTS", root / "environments")),
        workspace_dir=Path(os.environ.get("LEETCLAUDE_WORKSPACE", root / "workspace")),
        cache_dir=Path(os.environ.get("LEETCLAUDE_CACHE", Path.home() / ".cache" / "leetclaude")),
        executors_file=Path(
            os.environ.get(
                "LEETCLAUDE_EXECUTORS", Path.home() / ".config" / "leetclaude" / "executors.yaml"
            )
        ),
        # Index used when provisioning sandbox environments. Defaults to public PyPI so a
        # private global pip/uv config doesn't leak into problem environments.
        package_index=os.environ.get("LEETCLAUDE_PACKAGE_INDEX", "https://pypi.org/simple"),
    )
