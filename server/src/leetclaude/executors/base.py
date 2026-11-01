"""Executors decide *where* a job bundle runs (local subprocess, SSH host, SLURM, ...)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

from leetclaude.envs.registry import satisfies
from leetclaude.schema.models import Environment, ExecutorConfig


@dataclass
class JobSpec:
    run_id: str
    bundle: Path                      # local directory with run.json, user/, ref/, _lc/
    command: list[str]                # template; {python} and {bundle} are substituted
    build: list[list[str]] = field(default_factory=list)
    env: dict[str, str] = field(default_factory=dict)
    workdir: str = "."                # relative to the bundle
    timeout_s: float = 10.0
    build_timeout_s: float = 120.0
    results_file: str = "results.jsonl"


@dataclass
class ExecOutcome:
    exit_code: int | None
    stdout: str = ""
    stderr: str = ""
    results: str = ""                 # raw JSONL written by the harness
    timed_out: bool = False
    cancelled: bool = False
    build_failed: bool = False
    build_output: str = ""
    duration_ms: float = 0.0


# Progress callback: on_status("preparing" | "queued" | "running", detail)
StatusCallback = Callable[[str, str], Awaitable[None]]


async def _no_status(phase: str, detail: str) -> None:
    return None


class Executor(ABC):
    kind: str

    def __init__(self, config: ExecutorConfig) -> None:
        self.config = config

    @property
    def id(self) -> str:
        return self.config.id

    @abstractmethod
    def capabilities(self) -> set[str]: ...

    def supports(self, requires: list[str]) -> bool:
        return satisfies(self.capabilities(), requires)

    def device_for(self, requires: list[str]) -> str:
        caps = self.capabilities()
        if not ({"gpu", "cuda"} & set(requires)):
            return "cpu"
        if "cuda" in caps:
            return "cuda"
        if "mps" in caps:
            return "mps"
        return "cpu"

    def describe(self) -> dict:
        return {"id": self.id, "kind": self.kind, "capabilities": sorted(self.capabilities()),
                "description": self.config.description}

    @abstractmethod
    async def prepare(self, env: Environment, extra_deps: list[str]) -> dict[str, str]:
        """Make the environment available; return template values (e.g. {"python": ...})."""

    @abstractmethod
    async def run(self, job: JobSpec, values: dict[str, str],
                  on_status: StatusCallback = _no_status) -> ExecOutcome: ...

    async def cancel(self, run_id: str) -> bool:
        return False
