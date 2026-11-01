"""Process-wide state shared by the REST API, the WebSocket hub and the MCP server."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any

from pathlib import Path

from fastapi import WebSocket

from leetclaude.config import settings

from leetclaude.envs.registry import EnvironmentRegistry
from leetclaude.executors import ExecutorManager
from leetclaude.runner import Orchestrator
from leetclaude.store.problems import ProblemStore
from leetclaude.store.workspace import Workspace


class Hub:
    """Broadcasts JSON events to every connected browser tab."""

    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()

    async def broadcast(self, event: dict[str, Any]) -> None:
        dead = []
        for ws in list(self.clients):
            try:
                await ws.send_json(event)
            except Exception:  # noqa: BLE001
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


@dataclass
class Session:
    """What the user is doing right now, as reported by the browser."""

    problem_id: str | None = None
    buffers: dict[str, str] = field(default_factory=dict)   # unsaved editor content
    active_file: str | None = None
    cursor: dict[str, int] | None = None                    # {line, column}
    selection: dict[str, Any] | None = None                 # {start_line, ..., text}
    executor: str | None = None
    updated_at: float = 0.0

    def update(self, **kw: Any) -> None:
        changed_identity = any(k in kw and kw[k] != getattr(self, k)
                               for k in ("problem_id", "active_file", "executor"))
        for k, v in kw.items():
            setattr(self, k, v)
        self.updated_at = time.time()
        if changed_identity:
            self.save()

    # persisted so MCP tools know the open problem across server restarts
    @staticmethod
    def _file() -> Path:
        return settings().workspace_dir / ".session.json"

    def save(self) -> None:
        path = self._file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"problem_id": self.problem_id, "active_file": self.active_file,
                                    "executor": self.executor}))

    @classmethod
    def load(cls) -> "Session":
        try:
            data = json.loads(cls._file().read_text())
            return cls(problem_id=data.get("problem_id"), active_file=data.get("active_file"),
                       executor=data.get("executor"))
        except (OSError, ValueError):
            return cls()


class AppState:
    def __init__(self) -> None:
        self.problems = ProblemStore()
        self.workspace = Workspace()
        self.environments = EnvironmentRegistry()
        self.executors = ExecutorManager()
        self.orchestrator = Orchestrator(self.executors, self.environments)
        self.hub = Hub()
        self.session = Session.load()
        self.run_lock: dict[str, asyncio.Lock] = {}


@lru_cache
def app_state() -> AppState:
    return AppState()
