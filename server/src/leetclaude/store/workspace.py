"""User state per problem: workspace/<problem-id>/.

Editable files live as real files (so the user's AI can open them). App state lives in
workspace/<problem-id>/.leetclaude/*.json.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

from leetclaude.config import settings
from leetclaude.schema.models import Problem

STATE_DIR = ".leetclaude"


class Workspace:
    def __init__(self, root: Path | None = None) -> None:
        self.root = root or settings().workspace_dir
        # last content this process wrote per (problem, path); lets the watcher tell our own
        # writes apart from edits made directly on disk by someone else (e.g. an AI agent)
        self._written: dict[tuple[str, str], str] = {}

    def _write(self, problem_id: str, path: str, content: str) -> None:
        target = self.dir(problem_id) / path
        target.parent.mkdir(parents=True, exist_ok=True)
        self._written[(problem_id, path)] = content
        target.write_text(content)

    def last_written(self, problem_id: str, path: str) -> str | None:
        return self._written.get((problem_id, path))

    def dir(self, problem_id: str) -> Path:
        return self.root / problem_id

    def _state(self, problem_id: str, name: str) -> Path:
        return self.dir(problem_id) / STATE_DIR / f"{name}.json"

    # files -----------------------------------------------------------------
    def ensure(self, problem: Problem) -> None:
        """Write starter files that don't exist yet."""
        for f in problem.editable_files():
            path = self.dir(problem.id) / f.path
            if not path.exists():
                self._write(problem.id, f.path, f.content)
            elif (problem.id, f.path) not in self._written:
                self._written[(problem.id, f.path)] = path.read_text()

    def files(self, problem: Problem) -> dict[str, str]:
        self.ensure(problem)
        return {
            f.path: (self.dir(problem.id) / f.path).read_text() for f in problem.editable_files()
        }

    def save_files(self, problem: Problem, files: dict[str, str]) -> dict[str, str]:
        editable = {f.path for f in problem.editable_files()}
        written = {}
        for path, content in files.items():
            if path not in editable:
                raise ValueError(f"{path!r} is not an editable file of {problem.id}")
            target = self.dir(problem.id) / path
            if not target.exists() or target.read_text() != content:
                self._write(problem.id, path, content)
                written[path] = content
            else:
                self._written[(problem.id, path)] = content
        return written

    def reset(self, problem: Problem) -> dict[str, str]:
        for f in problem.editable_files():
            self._write(problem.id, f.path, f.content)
        return self.files(problem)

    def remove(self, problem_id: str) -> None:
        shutil.rmtree(self.dir(problem_id), ignore_errors=True)

    # json state ------------------------------------------------------------
    def read_state(self, problem_id: str, name: str, default: Any) -> Any:
        path = self._state(problem_id, name)
        if not path.exists():
            return default
        try:
            return json.loads(path.read_text())
        except json.JSONDecodeError:
            return default

    def write_state(self, problem_id: str, name: str, value: Any) -> None:
        path = self._state(problem_id, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(value, indent=2, default=str))
        tmp.replace(path)
