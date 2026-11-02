"""Tiny plugin registries. Each layer registers implementations by name:

    @register("executor", "slurm")
    class SlurmExecutor(Executor): ...

Adding a language, judge kind or executor kind = one new module + one import in its package
__init__.
"""

from __future__ import annotations

from typing import Any, Callable, TypeVar

T = TypeVar("T")

_REGISTRIES: dict[str, dict[str, Any]] = {"executor": {}, "language": {}, "judge": {}}


def register(layer: str, name: str) -> Callable[[T], T]:
    def deco(obj: T) -> T:
        _REGISTRIES[layer][name] = obj
        return obj

    return deco


def lookup(layer: str, name: str) -> Any:
    try:
        return _REGISTRIES[layer][name]
    except KeyError:
        known = ", ".join(sorted(_REGISTRIES[layer])) or "none"
        raise KeyError(f"unknown {layer} {name!r} (known: {known})") from None


def names(layer: str) -> list[str]:
    return sorted(_REGISTRIES[layer])
