"""Tutorial operations: list, open, save the learner's cells, run one cell, validate, and the
agent side (author, validate, open, run a cell, describe the learner's session).

A cell run is a console snippet (`ToolService.run_console`'s pipeline) with the earlier cells
replayed first and the cell's hidden checks run afterwards. It never touches a problem's
`last_run`. The learner's code lives in the workspace of the tutorial's shim problem.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from typing import Any, Protocol

from leegen.core.compat import requirements
from leegen.core.models import ConsoleResult, Problem
from leegen.core.parse import format_error
from leegen.core.tutorial import (SHIM_PREFIX, Tutorial, cell_path, cell_run_inputs, is_shim_id,
                                  parse_tutorial_yaml, public_tutorial, reference_files,
                                  reference_issues, session_cells, shim_id, shim_problem,
                                  starter_issues, tutorial_summary)
from leegen.runner import Orchestrator, SnippetRequest
from leegen.service import EnvironmentSource, EventSink, SessionState, WorkspaceRepo

RESULTS = "cell_results"      # workspace state: {cell_id: {status, checks, ran_at}}


class TutorialRepo(Protocol):
    def get(self, tutorial_id: str) -> Tutorial | None: ...
    def list(self) -> list[Tutorial]: ...
    def errors(self) -> list[Any]: ...
    def read_yaml(self, tutorial_id: str) -> str | None: ...
    def save_yaml(self, tutorial_id: str, text: str) -> Path: ...
    def delete(self, tutorial_id: str) -> bool: ...


def _summarise(result: ConsoleResult) -> dict[str, Any]:
    passed = bool(result.checks) and all(c.status == "pass" for c in result.checks)
    return {"status": result.status, "passed": passed and result.status == "ok",
            "checks": [c.model_dump() for c in result.checks], "ran_at": time.time()}


class TutorialService:
    def __init__(self, *, tutorials: TutorialRepo, workspace: WorkspaceRepo,
                 orchestrator: Orchestrator, environments: EnvironmentSource,
                 events: EventSink, run_lock: dict[str, asyncio.Lock],
                 session: SessionState | None = None, docs_dir: Path | None = None) -> None:
        self.tutorials = tutorials
        self.workspace = workspace
        self.orchestrator = orchestrator
        self.environments = environments
        self.events = events
        self.run_lock = run_lock
        self.session = session
        self.docs_dir = docs_dir

    def tutorial(self, tutorial_id: str) -> Tutorial:
        t = self.tutorials.get(tutorial_id)
        if t is None:
            raise LookupError(f"no tutorial {tutorial_id!r}")
        return t

    def list_view(self) -> dict[str, Any]:
        items = []
        for t in self.tutorials.list():
            done = self.workspace.read_state(shim_problem(t).id, RESULTS, {})
            code = t.code_cells()
            items.append({**tutorial_summary(t),
                          "passed": sum(1 for c in code if done.get(c.id, {}).get("passed"))})
        return {"tutorials": items,
                "errors": [{"path": e.path, "error": e.error} for e in self.tutorials.errors()]}

    def open(self, tutorial_id: str) -> dict[str, Any]:
        t = self.tutorial(tutorial_id)
        shim = shim_problem(t)
        return {**public_tutorial(t), "files": self.workspace.files(shim),
                "results": self.workspace.read_state(shim.id, RESULTS, {}),
                "annotations": self.workspace.read_state(shim.id, "annotations", []),
                "proposals": self.workspace.read_state(shim.id, "proposals", [])}

    def save_files(self, tutorial_id: str, files: dict[str, str]) -> dict[str, Any]:
        shim = shim_problem(self.tutorial(tutorial_id))
        return {"written": sorted(self.workspace.save_files(shim, files))}

    def reset(self, tutorial_id: str, cell_id: str | None = None) -> dict[str, Any]:
        t = self.tutorial(tutorial_id)
        shim = shim_problem(t)
        if cell_id is None:
            self.workspace.write_state(shim.id, RESULTS, {})
            return {"files": self.workspace.reset(shim), "results": {}}
        cell = next((c for c in t.code_cells() if c.id == cell_id), None)
        if cell is None:
            raise LookupError(f"no cell {cell_id!r}")
        self.workspace.save_files(shim, {cell_path(cell.id): cell.starter})
        results = self.workspace.read_state(shim.id, RESULTS, {})
        results.pop(cell_id, None)
        self.workspace.write_state(shim.id, RESULTS, results)
        return {"files": self.workspace.files(shim), "results": results}

    async def run_cell(self, tutorial_id: str, cell_id: str, *, files: dict[str, str] | None = None,
                       executor: str | None = None, run_id: str | None = None,
                       source: str = "ui", save: bool = True) -> ConsoleResult:
        """Run one cell on the learner's code and keep its outcome. `files` are live buffers:
        saved first unless `save` is false (an agent's run must not persist unsaved text)."""
        t = self.tutorial(tutorial_id)
        shim = shim_problem(t)
        if files and save:
            self.workspace.save_files(shim, files)
        current = {**self.workspace.files(shim), **(files or {})}
        inputs = cell_run_inputs(t, current, cell_id)
        run_id = run_id or uuid.uuid4().hex[:12]
        lock = self.run_lock.setdefault(shim.id, asyncio.Lock())
        async with lock:
            await self.events.broadcast({"type": "console_started", "problem_id": shim.id,
                                         "run_id": run_id, "source": source,
                                         "file": cell_path(cell_id)})

            async def on_output(stream: str, text: str) -> None:
                await self.events.broadcast({"type": "console_output", "problem_id": shim.id,
                                             "run_id": run_id, "stream": stream, "text": text})

            result = await self.orchestrator.run_snippet(
                SnippetRequest(problem=shim, files=current, code=inputs["code"],
                               stdin=inputs["stdin"], prior=inputs["prior"],
                               checks=inputs["checks"], executor=executor),
                run_id=run_id, on_output=on_output)
        results = self.workspace.read_state(shim.id, RESULTS, {})
        results[cell_id] = _summarise(result)
        self.workspace.write_state(shim.id, RESULTS, results)
        done = result.model_dump(mode="json")
        await self.events.broadcast({"type": "console_finished", "problem_id": shim.id,
                                     "run_id": run_id, "source": source, "result": done})
        await self.events.broadcast({"type": "tutorial_cell_finished", "tutorial_id": t.id,
                                     "cell": cell_id, "run_id": run_id, "source": source,
                                     "result": done})
        return result

    async def validate(self, t: Tutorial, executor: str | None = None) -> dict[str, Any]:
        """Replay the references: every check must pass. Starters must fail a check."""
        shim = shim_problem(t)
        ref = reference_files(t)
        env = self.environments.get(t.environment)
        if env is None or env.language != "python":
            return {"ok": False, "issues": [f"environment {t.environment!r} is not a Python one"]}
        try:
            self.orchestrator.executors.choose(requirements(shim, env), executor, env=env)
        except LookupError as exc:
            return {"ok": False, "skipped": True, "summary": "no executor can run this; not run",
                    "issues": [str(exc)]}
        issues: list[str] = []
        for c in t.code_cells():
            if not c.checks:
                continue
            for want_pass, files in ((True, ref), (False, {**ref, cell_path(c.id): c.starter})):
                inputs = cell_run_inputs(t, files, c.id)
                result = await self.orchestrator.run_snippet(SnippetRequest(
                    problem=shim, files=files, code=inputs["code"], stdin=inputs["stdin"],
                    prior=inputs["prior"], checks=inputs["checks"], executor=executor))
                issues += (reference_issues if want_pass else starter_issues)(c.id, result)
        return {"ok": not issues, "issues": issues,
                "summary": f"{len(t.code_cells())} code cells, "
                           f"{sum(1 for c in t.code_cells() if c.checks)} with checks"}

    # ---------------------------------------------------------------- agent side

    def guide(self) -> str:
        path = self.docs_dir / "tutorials.md" if self.docs_dir else None
        return path.read_text() if path and path.exists() else "docs/tutorials.md is missing"

    def shim_for(self, shim_problem_id: str) -> Problem:
        """The stand-in problem of a tutorial (`tut-<id>`), for review comments and edits."""
        t = self.tutorials.get(shim_problem_id[len(SHIM_PREFIX):]) if is_shim_id(shim_problem_id) else None
        if t is None:
            raise LookupError(f"no tutorial for {shim_problem_id!r}; call list_tutorials")
        return shim_problem(t)

    def _open_id(self) -> str | None:
        pid = self.session.problem_id if self.session else None
        return pid[len(SHIM_PREFIX):] if pid and is_shim_id(pid) else None

    def _target(self, tutorial_id: str | None) -> Tutorial:
        tid = tutorial_id or self._open_id()
        if not tid:
            raise ValueError("no tutorial_id given and the user has no tutorial open")
        return self.tutorial(tid)

    def current_files(self, t: Tutorial) -> dict[str, str]:
        """The learner's cells as they see them: unsaved browser buffers win over disk."""
        shim = shim_problem(t)
        files = self.workspace.files(shim)
        if self.session and self.session.problem_id == shim.id:
            files.update({k: v for k, v in self.session.buffers.items() if k in files})
        return files

    def agent_list(self, track: str | None = None) -> dict[str, Any]:
        view = self.list_view()
        return {"tutorials": [t for t in view["tutorials"] if not track or t["track"] == track],
                "invalid_files": view["errors"]}

    def agent_get(self, tutorial_id: str, include_hidden: bool = True) -> dict[str, Any]:
        t = self.tutorial(tutorial_id)
        if include_hidden:
            return {"id": t.id, "yaml": self.tutorials.read_yaml(t.id)}
        return public_tutorial(t)

    async def validate_yaml(self, text: str) -> tuple[Tutorial | None, dict[str, Any]]:
        try:
            t = parse_tutorial_yaml(text)
        except Exception as exc:  # noqa: BLE001
            return None, {"ok": False, "stage": "schema", "errors": format_error(exc)}
        return t, {"stage": "run", **await self.validate(t)}

    async def create(self, text: str, overwrite: bool = False) -> dict[str, Any]:
        t, report = await self.validate_yaml(text)
        if t is None:
            return {"saved": False, **report}
        if self.tutorials.get(t.id) and not overwrite:
            return {"saved": False, "ok": False,
                    "errors": f"tutorial {t.id!r} exists; pass overwrite=true to replace it"}
        if not report.get("ok") and not report.get("skipped"):
            return {"saved": False, **report}
        path = self.tutorials.save_yaml(t.id, text)
        await self.events.broadcast({"type": "tutorials_changed"})
        await self.events.broadcast({"type": "tutorial_changed", "tutorial_id": t.id})
        return {"saved": True, "path": str(path), "validated": bool(report.get("ok")), **report}

    async def update(self, tutorial_id: str, text: str) -> dict[str, Any]:
        if self.tutorials.get(tutorial_id) is None:
            return {"saved": False, "errors": f"no tutorial {tutorial_id!r}"}
        try:
            if parse_tutorial_yaml(text).id != tutorial_id:
                return {"saved": False, "errors": "the YAML id must equal tutorial_id"}
        except Exception as exc:  # noqa: BLE001
            return {"saved": False, "ok": False, "stage": "schema", "errors": format_error(exc)}
        return await self.create(text, overwrite=True)

    async def delete(self, tutorial_id: str, delete_user_code: bool = False) -> dict[str, Any]:
        removed = self.tutorials.delete(tutorial_id)
        if delete_user_code:
            self.workspace.remove(shim_id(tutorial_id))
        await self.events.broadcast({"type": "tutorials_changed"})
        return {"deleted": removed}

    async def navigate(self, tutorial_id: str) -> dict[str, Any]:
        t = self.tutorial(tutorial_id)
        await self.events.broadcast({"type": "navigate_tutorial", "tutorial_id": t.id})
        return {"opened": t.id}

    async def run_for_agent(self, tutorial_id: str | None = None,
                            cell: str | None = None) -> dict[str, Any]:
        """Run a cell on the learner's current code, as the Run button does."""
        t = self._target(tutorial_id)
        if cell is None and self.session and self.session.active_file:
            cell = next((c.id for c in t.code_cells()
                         if cell_path(c.id) == self.session.active_file), None)
        if cell is None:
            raise ValueError("no cell given and none is active; pass cell")
        if cell not in {c.id for c in t.code_cells()}:
            raise LookupError(f"no cell {cell!r}; the code cells are "
                              + ", ".join(c.id for c in t.code_cells()))
        result = await self.run_cell(t.id, cell, files=self.current_files(t), source="mcp",
                                     save=False)
        return {"tutorial_id": t.id, "cell": cell, "status": result.status,
                "passed": result.status == "ok" and bool(result.checks)
                and all(c.status == "pass" for c in result.checks),
                "checks": [c.model_dump() for c in result.checks],
                "stdout": result.stdout[-4000:], "stderr": result.stderr[-4000:],
                "result": result.result, "error": result.error}

    def session_view(self) -> dict[str, Any]:
        """`get_session` while the user has a tutorial open."""
        s = self.session
        t = self.tutorials.get(self._open_id() or "")
        if s is None or t is None:
            return {"problem_id": None, "message": "The user has no problem open."}
        shim = shim_problem(t)
        state = lambda name, default: self.workspace.read_state(shim.id, name, default)  # noqa: E731
        active = next((c.id for c in t.code_cells() if cell_path(c.id) == s.active_file), None)
        return {
            "kind": "tutorial", "problem_id": shim.id, "tutorial_id": t.id, "title": t.title,
            "summary": t.summary, "environment": t.environment,
            "cells": session_cells(t, self.current_files(t), state(RESULTS, {})),
            "active_cell": active, "active_file": s.active_file,
            "cursor": s.cursor, "selection": s.selection,
            "annotations": state("annotations", []),
            "pending_proposals": [{k: v for k, v in x.items() if k != "content"}
                                  for x in state("proposals", [])],
            "seconds_since_activity": round(time.time() - s.updated_at, 1) if s.updated_at else None,
        }
