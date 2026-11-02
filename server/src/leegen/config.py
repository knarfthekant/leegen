"""Paths and settings. Everything is overridable with LEEGEN_* environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path


def _default_root() -> Path:
    # server/src/leegen/config.py -> repo root is three levels above the package dir
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
    host: str = "127.0.0.1"
    port: int = 13370
    web_port: int = 13371

    @property
    def docs_dir(self) -> Path:
        return self.root / "docs"

    @property
    def web_dir(self) -> Path:
        return self.root / "web"

    @property
    def web_dist(self) -> Path:
        return self.web_dir / "dist"


@lru_cache
def settings() -> Settings:
    root = Path(os.environ.get("LEEGEN_ROOT", _default_root())).resolve()
    return Settings(
        root=root,
        problems_dir=Path(os.environ.get("LEEGEN_PROBLEMS", root / "problems")),
        environments_dir=Path(os.environ.get("LEEGEN_ENVIRONMENTS", root / "environments")),
        workspace_dir=Path(os.environ.get("LEEGEN_WORKSPACE", root / "workspace")),
        cache_dir=Path(os.environ.get("LEEGEN_CACHE", Path.home() / ".cache" / "leegen")),
        executors_file=Path(
            os.environ.get(
                "LEEGEN_EXECUTORS", Path.home() / ".config" / "leegen" / "executors.yaml"
            )
        ),
        # Index used when provisioning sandbox environments. Defaults to public PyPI so a
        # private global pip/uv config doesn't leak into problem environments.
        package_index=os.environ.get("LEEGEN_PACKAGE_INDEX", "https://pypi.org/simple"),
        # 13370 = "leet" + 0, chosen to stay clear of the usual 3000/5173/8000/8080 dev ports.
        host=os.environ.get("LEEGEN_HOST", "127.0.0.1"),
        port=int(os.environ.get("LEEGEN_PORT", "13370")),
        web_port=int(os.environ.get("LEEGEN_WEB_PORT", "13371")),
    )
