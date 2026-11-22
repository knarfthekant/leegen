"""Tutorial operations: list, open, save the learner's cells, run one cell, validate.

A cell run is a console snippet (`ToolService.run_console`'s pipeline) with the earlier cells
replayed first and the cell's hidden checks run afterwards. It never touches a problem's
`last_run`. The learner's code lives in the workspace of the tutorial's shim problem.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Protocol

from leegen.core.models import ConsoleResult
from leegen.core.tutorial import (Tutorial, cell_path, cell_run_inputs, public_tutorial,
                                  reference_files, shim_problem, tutorial_summary)
from leegen.runner import Orchestrator, SnippetRequest
from leegen.service import EnvironmentSource, EventSink, WorkspaceRepo

RESULTS = "cell_results"      # workspace state: {cell_id: {status, checks, ran_at}}


class TutorialRepo(Protocol):
    def get(self, tutorial_id: str) -> Tutorial | None: ...
    def list(self) -> list[Tutorial]: ...
    def errors(self) -> list[Any]: ...


def _summarise(result: ConsoleResult) -> dict[str, Any]:
    passed = bool(result.checks) and all(c.status == "pass" for c in result.checks)
    return {"status": result.status, "passed": passed and result.status == "ok",
            "checks": [c.model_dump() for c in result.checks], "ran_at": time.time()}


class TutorialService:
    def __init__(self, *, tutorials: TutorialRepo, workspace: WorkspaceRepo,
                 orchestrator: Orchestrator, environments: EnvironmentSource,
                 events: EventSink, run_lock: dict[str, asyncio.Lock]) -> None:
        self.tutorials = tutorials
        self.workspace = workspace
        self.orchestrator = orchestrator
        self.environments = environments
        self.events = events
        self.run_lock = run_lock

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
                "results": self.workspace.read_state(shim.id, RESULTS, {})}

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
                       executor: str | None = None, run_id: str | None = None) -> ConsoleResult:
        t = self.tutorial(tutorial_id)
        shim = shim_problem(t)
        if files:
            self.workspace.save_files(shim, files)
        current = self.workspace.files(shim)
        inputs = cell_run_inputs(t, current, cell_id)
        run_id = run_id or uuid.uuid4().hex[:12]
        lock = self.run_lock.setdefault(shim.id, asyncio.Lock())
        async with lock:
            await self.events.broadcast({"type": "console_started", "problem_id": shim.id,
                                         "run_id": run_id, "source": "tutorial",
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
        await self.events.broadcast({"type": "console_finished", "problem_id": shim.id,
                                     "run_id": run_id, "source": "tutorial",
                                     "result": result.model_dump(mode="json")})
        return result

    async def validate(self, t: Tutorial, executor: str | None = None) -> dict[str, Any]:
        """Replay the references: every check must pass. Starters must fail a check."""
        shim = shim_problem(t)
        ref = reference_files(t)
        env = self.environments.get(t.environment)
        if env is None or env.language != "python":
            return {"ok": False, "issues": [f"environment {t.environment!r} is not a Python one"]}
        issues: list[str] = []
        for c in t.code_cells():
            if not c.checks:
                continue
            for label, files, want_pass in (("reference", ref, True),
                                            ("starter", {**ref, cell_path(c.id): c.starter}, False)):
                inputs = cell_run_inputs(t, files, c.id)
                result = await self.orchestrator.run_snippet(SnippetRequest(
                    problem=shim, files=files, code=inputs["code"], stdin=inputs["stdin"],
                    prior=inputs["prior"], checks=inputs["checks"], executor=executor))
                if want_pass:
                    if result.status != "ok":
                        issues.append(f"cell {c.id}: reference raised: {(result.error or '')[-300:]}")
                    for ck in result.checks:
                        if ck.status != "pass":
                            issues.append(f"cell {c.id}: reference fails check "
                                          f"{ck.description!r} ({ck.message or ck.status})")
                elif result.status == "ok" and result.checks and all(
                        ck.status == "pass" for ck in result.checks):
                    issues.append(f"cell {c.id}: the starter already passes every check")
        return {"ok": not issues, "issues": issues,
                "summary": f"{len(t.code_cells())} code cells, "
                           f"{sum(1 for c in t.code_cells() if c.checks)} with checks"}
