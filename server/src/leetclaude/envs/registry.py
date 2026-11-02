"""Environment specs from environments/*.yaml."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from pathlib import Path

import yaml

from leetclaude.config import settings
from leetclaude.core.compat import satisfies  # noqa: F401  (re-exported)
from leetclaude.core.models import Environment


def env_hash(env: Environment, extra_deps: Iterable[str] = ()) -> str:
    payload = json.dumps(
        {"python": env.python, "deps": sorted({*env.dependencies, *extra_deps})}, sort_keys=True
    )
    return hashlib.sha256(payload.encode()).hexdigest()[:12]


class EnvironmentRegistry:
    def __init__(self, directory: Path | None = None) -> None:
        self.dir = directory or settings().environments_dir

    def all(self) -> dict[str, Environment]:
        envs: dict[str, Environment] = {}
        for path in sorted(self.dir.glob("*.yaml")):
            env = Environment.model_validate(yaml.safe_load(path.read_text()))
            envs[env.id] = env
        return envs

    def get(self, env_id: str) -> Environment | None:
        return self.all().get(env_id)
