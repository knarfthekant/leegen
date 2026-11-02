"""Problem YAML <-> model. pyyaml + pydantic only (both ship with Pyodide)."""

from __future__ import annotations

import yaml
from pydantic import ValidationError

from leetclaude.core.models import Problem


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
