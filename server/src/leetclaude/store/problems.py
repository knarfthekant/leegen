"""Problem bank: YAML files in problems/. One file per problem, `<id>.yaml`."""

from __future__ import annotations

import threading
from dataclasses import dataclass
from pathlib import Path

import yaml
from pydantic import ValidationError

from leetclaude.config import settings
from leetclaude.schema.models import Problem


class _BlockDumper(yaml.SafeDumper):
    pass


def _str_representer(dumper: yaml.SafeDumper, data: str) -> yaml.Node:
    style = "|" if "\n" in data else None
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style=style)


_BlockDumper.add_representer(str, _str_representer)


def dump_problem_yaml(problem: Problem) -> str:
    data = problem.model_dump(mode="json", exclude_defaults=True)
    data = {"schema_version": 1, **data}
    return yaml.dump(data, Dumper=_BlockDumper, sort_keys=False, allow_unicode=True, width=100)


def parse_problem_yaml(text: str) -> Problem:
    data = yaml.safe_load(text)
    if not isinstance(data, dict):
        raise ValueError("problem YAML must be a mapping at the top level")
    return Problem.model_validate(data)


def format_error(exc: Exception) -> str:
    if isinstance(exc, ValidationError):
        lines = []
        for err in exc.errors():
            loc = ".".join(str(x) for x in err["loc"]) or "<root>"
            lines.append(f"{loc}: {err['msg']}")
        return "\n".join(lines)
    return str(exc)


@dataclass
class LoadError:
    path: str
    error: str


class ProblemStore:
    def __init__(self, directory: Path | None = None) -> None:
        self.dir = directory or settings().problems_dir
        self._lock = threading.Lock()
        self._cache: dict[Path, tuple[float, Problem | LoadError]] = {}

    def _scan(self) -> list[Problem | LoadError]:
        out: list[Problem | LoadError] = []
        seen: set[Path] = set()
        with self._lock:
            for path in sorted(self.dir.glob("*.yaml")):
                seen.add(path)
                mtime = path.stat().st_mtime
                cached = self._cache.get(path)
                if cached and cached[0] == mtime:
                    out.append(cached[1])
                    continue
                try:
                    item: Problem | LoadError = parse_problem_yaml(path.read_text())
                    if item.id != path.stem:
                        item = LoadError(str(path), f"id {item.id!r} does not match file name")
                except Exception as exc:  # noqa: BLE001 - surfaced to agents
                    item = LoadError(str(path), format_error(exc))
                self._cache[path] = (mtime, item)
                out.append(item)
            for stale in set(self._cache) - seen:
                del self._cache[stale]
        return out

    def list(self) -> list[Problem]:
        return [p for p in self._scan() if isinstance(p, Problem)]

    def errors(self) -> list[LoadError]:
        return [p for p in self._scan() if isinstance(p, LoadError)]

    def get(self, problem_id: str) -> Problem | None:
        return next((p for p in self.list() if p.id == problem_id), None)

    def path_for(self, problem_id: str) -> Path:
        return self.dir / f"{problem_id}.yaml"

    def save(self, problem: Problem) -> Path:
        self.dir.mkdir(parents=True, exist_ok=True)
        path = self.path_for(problem.id)
        tmp = path.with_suffix(".yaml.tmp")
        tmp.write_text(dump_problem_yaml(problem))
        tmp.replace(path)
        return path

    def delete(self, problem_id: str) -> bool:
        path = self.path_for(problem_id)
        if path.exists():
            path.unlink()
            return True
        return False
