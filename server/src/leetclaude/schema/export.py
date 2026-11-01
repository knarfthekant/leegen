"""Export the problem JSON Schema (schema/problem.schema.json)."""

from __future__ import annotations

import json
from pathlib import Path

from leetclaude.config import settings
from leetclaude.schema.models import Problem


def problem_json_schema() -> dict:
    schema = Problem.model_json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = "https://leetclaude.local/schema/problem.schema.json"
    return schema


def write_schema(path: Path | None = None) -> Path:
    path = path or settings().root / "schema" / "problem.schema.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(problem_json_schema(), indent=2) + "\n")
    return path
