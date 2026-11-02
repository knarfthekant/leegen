"""Which executor can run which problem: hardware requirements plus the Python runtime."""

from __future__ import annotations

from collections.abc import Iterable

from leegen.core.models import Environment, Problem


def satisfies(capabilities: Iterable[str], requires: Iterable[str]) -> bool:
    caps = set(capabilities)
    for req in requires:
        if req == "cpu" and "cpu" not in caps:
            return False
        if req == "gpu" and not caps & {"cuda", "mps", "gpu"}:
            return False
        if req == "cuda" and "cuda" not in caps:
            return False
        if req == "webgpu" and "webgpu" not in caps:
            return False
    return True


def requirements(problem: Problem, env: Environment | None) -> list[str]:
    return sorted({*problem.requires, *(env.requires if env else [])})


def runtime_ok(runtime: str, env: Environment | None) -> bool:
    """An environment without a spec (unknown) is treated as native-only."""
    return runtime in (env.runtimes() if env else {"native"})


def can_run(capabilities: Iterable[str], runtime: str, requires: Iterable[str],
            env: Environment | None) -> bool:
    return runtime_ok(runtime, env) and satisfies(capabilities, requires)


def device_for(capabilities: Iterable[str], requires: Iterable[str]) -> str:
    caps, reqs = set(capabilities), set(requires)
    if "webgpu" in reqs:
        return "webgpu"
    if not ({"gpu", "cuda"} & reqs):
        return "cpu"
    if "cuda" in caps:
        return "cuda"
    if "mps" in caps:
        return "mps"
    return "cpu"
