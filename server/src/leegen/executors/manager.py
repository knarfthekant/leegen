"""Loads executors.yaml and picks an executor for a problem."""

from __future__ import annotations

from pathlib import Path

import yaml

from leegen.config import settings
from leegen.executors.base import Executor
from leegen.registry import lookup
from leegen.core.models import Environment, ExecutorConfig

DEFAULT = [ExecutorConfig(id="local", kind="local", description="This machine")]


class ExecutorManager:
    def __init__(self, config_file: Path | None = None) -> None:
        self.config_file = config_file or settings().executors_file
        self._executors: dict[str, Executor] | None = None

    def _load(self) -> dict[str, Executor]:
        configs = list(DEFAULT)
        if self.config_file.exists():
            raw = yaml.safe_load(self.config_file.read_text()) or []
            items = raw.get("executors", []) if isinstance(raw, dict) else raw
            loaded = [ExecutorConfig.model_validate(item) for item in items]
            if any(c.id == "local" for c in loaded):
                configs = []
            configs += loaded
        out: dict[str, Executor] = {}
        for cfg in configs:
            out[cfg.id] = lookup("executor", cfg.kind)(cfg)
        return out

    def all(self) -> dict[str, Executor]:
        if self._executors is None:
            self._executors = self._load()
        return self._executors

    def get(self, executor_id: str) -> Executor | None:
        return self.all().get(executor_id)

    def compatible(self, requires: list[str], env: Environment | None = None) -> list[Executor]:
        return [e for e in self.all().values() if e.supports(requires, env)]

    def choose(self, requires: list[str], preferred: str | None = None,
               env: Environment | None = None) -> Executor:
        candidates = self.compatible(requires, env)
        if preferred:
            match = next((e for e in candidates if e.id == preferred), None)
            if match is None:
                raise LookupError(f"executor {preferred!r} cannot run a problem requiring "
                                  f"{requires} (or does not exist)")
            return match
        if not candidates:
            if env is not None and not env.native:
                raise LookupError(f"environment {env.id!r} runs only in the browser edition "
                                  f"(runtimes: {sorted(env.runtimes())})")
            raise LookupError(f"no configured executor provides {requires}; add one to "
                              f"{self.config_file}")
        return candidates[0]
