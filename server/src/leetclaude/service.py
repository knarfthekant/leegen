"""ToolService: every operation the web UI and agents can perform, in one place.

The REST API (api/routes.py) and the MCP server (mcp_server/server.py) are thin adapters over
this class, and the browser edition's TypeScript `BrowserToolService` mirrors it (checked
against contracts/fixtures). Dependencies are injected, so nothing here reaches for globals.

Errors: `LookupError` for unknown ids (REST 404), `ValueError` for bad arguments (REST 400). The
MCP layer passes both messages to the agent.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from pathlib import Path
from typing import Any, Literal, Protocol

from leetclaude.core import review
from leetclaude.core.compat import requirements
from leetclaude.core.models import Environment, Problem, RunResult
from leetclaude.core.parse import dump_problem_yaml, format_error, parse_problem_yaml
from leetclaude.core.toolspec import TUTORING_GUIDE
from leetclaude.core.validation import ValidationReport, validate
from leetclaude.core.views import brief_run, problem_summary, public_problem, run_status, sort_key
from leetclaude.runner import Orchestrator, RunRequest
from leetclaude.schema.export import problem_json_schema


# ------------------------------------------------------------------ injected dependencies


class ProblemRepo(Protocol):
    dir: Path

    def get(self, problem_id: str) -> Problem | None: ...
    def list(self) -> list[Problem]: ...
    def errors(self) -> list[Any]: ...
    def save(self, problem: Problem) -> Path: ...
    def delete(self, problem_id: str) -> bool: ...


class WorkspaceRepo(Protocol):
    def files(self, problem: Problem) -> dict[str, str]: ...
    def save_files(self, problem: Problem, files: dict[str, str]) -> dict[str, str]: ...
    def reset(self, problem: Problem) -> dict[str, str]: ...
    def remove(self, problem_id: str) -> None: ...
    def read_state(self, problem_id: str, name: str, default: Any) -> Any: ...
    def write_state(self, problem_id: str, name: str, value: Any) -> None: ...


class EventSink(Protocol):
    async def broadcast(self, event: dict[str, Any]) -> None: ...


class SessionState(Protocol):
    problem_id: str | None
    buffers: dict[str, str]
    active_file: str | None
    cursor: dict[str, int] | None
    selection: dict[str, Any] | None
    executor: str | None
    updated_at: float

    def update(self, **kw: Any) -> None: ...


class EnvironmentSource(Protocol):
    def all(self) -> dict[str, Environment]: ...
    def get(self, env_id: str) -> Environment | None: ...


# ------------------------------------------------------------------ the service


class ToolService:
    def __init__(self, *, problems: ProblemRepo, workspace: WorkspaceRepo,
                 session: SessionState, events: EventSink, orchestrator: Orchestrator,
                 environments: EnvironmentSource, docs_dir: Path) -> None:
        self.problems = problems
        self.workspace = workspace
        self.session = session
        self.events = events
        self.orchestrator = orchestrator
        self.environments = environments
        self.docs_dir = docs_dir
        self.run_lock: dict[str, asyncio.Lock] = {}

    @property
    def executors(self):  # type: ignore[no-untyped-def]
        return self.orchestrator.executors

    # ---------------------------------------------------------------- lookups

    def problem(self, problem_id: str | None = None) -> Problem:
        pid = problem_id or self.session.problem_id
        if not pid:
            raise ValueError("no problem_id given and the user has no problem open")
        p = self.problems.get(pid)
        if p is None:
            raise LookupError(f"no problem {pid!r}; call list_problems")
        return p

    def current_files(self, problem: Problem) -> dict[str, str]:
        """The user's code as they see it: unsaved browser buffers win over disk."""
        files = self.workspace.files(problem)
        if self.session.problem_id == problem.id:
            for path, content in self.session.buffers.items():
                if path in files:
                    files[path] = content
        return files

    def _state(self, problem_id: str, name: str, default: Any) -> Any:
        return self.workspace.read_state(problem_id, name, default)

    # ---------------------------------------------------------------- authoring

    def authoring_guide(self) -> str:
        guide = self.docs_dir / "authoring.md"
        return guide.read_text() if guide.exists() else "docs/authoring.md is missing"

    def tutoring_guide(self) -> str:
        return TUTORING_GUIDE

    def problem_schema(self) -> dict[str, Any]:
        return problem_json_schema()

    def list_environments(self) -> dict[str, Any]:
        out = []
        for env in self.environments.all().values():
            runnable = [e.id for e in self.executors.compatible(sorted(env.requires), env)]
            out.append({**env.model_dump(), "executors": runnable})
        return {"environments": out}

    def environment_list(self) -> dict[str, Any]:
        return {"environments": [e.model_dump() for e in self.environments.all().values()]}

    def list_executors(self) -> dict[str, Any]:
        return {"executors": [e.describe() for e in self.executors.all().values()]}

    def list_problems(self, track: str | None = None) -> dict[str, Any]:
        """Agent view: summaries plus files that failed to load."""
        items = [problem_summary(p) for p in self.problems.list() if not track or p.track == track]
        errors = [{"path": e.path, "error": e.error} for e in self.problems.errors()]
        return {"problems": items, "invalid_files": errors}

    def problem_list_view(self) -> dict[str, Any]:
        """UI view: summaries with a passed/attempted status, sorted by track and order."""
        items = []
        for p in self.problems.list():
            env = self.environments.get(p.environment)
            items.append({**problem_summary(p),
                          "status": run_status(self._state(p.id, "last_run", None)),
                          "runtimes": sorted(env.runtimes()) if env else ["native"]})
        items.sort(key=sort_key)
        errors = [{"path": e.path, "error": e.error} for e in self.problems.errors()]
        return {"problems": items, "errors": errors}

    def get_problem(self, problem_id: str, include_hidden: bool = True) -> dict[str, Any]:
        p = self.problem(problem_id)
        if include_hidden:
            return {"id": p.id, "yaml": dump_problem_yaml(p)}
        return public_problem(p)

    async def validate_problem(self, problem: Problem, executor: str | None = None,
                               orchestrator: Orchestrator | None = None) -> ValidationReport:
        orch = orchestrator or self.orchestrator
        env = self.environments.get(problem.environment)
        requires = requirements(problem, env)

        async def run(mode: str) -> RunResult:
            return await orch.run(RunRequest(problem=problem, mode=mode,  # type: ignore[arg-type]
                                             executor=executor))

        report = await validate(problem, env=env, known_envs=list(self.environments.all()),
                                runnable=bool(env and orch.executors.compatible(requires, env)),
                                requires=requires, run=run)
        if report.skipped and env is not None and "native" not in env.runtimes():
            report.summary = (f"{env.id!r} runs only in the browser edition (needs {requires}); "
                              "not run")
            report.issues = ["validate it in the browser edition (docs/browser.md)"]
        return report

    async def validate_yaml(self, yaml_text: str) -> tuple[Problem | None, dict[str, Any]]:
        try:
            problem = parse_problem_yaml(yaml_text)
        except Exception as exc:  # noqa: BLE001
            return None, {"ok": False, "stage": "schema", "errors": format_error(exc)}
        report = await self.validate_problem(problem)
        return problem, {"stage": "run", **report.to_dict()}

    async def create_problem(self, yaml_text: str, overwrite: bool = False) -> dict[str, Any]:
        problem, report = await self.validate_yaml(yaml_text)
        if problem is None:
            return {"saved": False, **report}
        if self.problems.get(problem.id) and not overwrite:
            return {"saved": False, "ok": False,
                    "errors": f"problem {problem.id!r} exists; pass overwrite=true to replace it"}
        if not report.get("ok") and not report.get("skipped"):
            return {"saved": False, **report}
        path = self.problems.save(problem)
        await self.events.broadcast({"type": "problems_changed"})
        await self.events.broadcast({"type": "problem_changed", "problem_id": problem.id})
        return {"saved": True, "path": str(path), "validated": bool(report.get("ok")), **report}

    async def update_problem(self, problem_id: str, yaml_text: str) -> dict[str, Any]:
        if self.problems.get(problem_id) is None:
            return {"saved": False, "errors": f"no problem {problem_id!r}"}
        try:
            if parse_problem_yaml(yaml_text).id != problem_id:
                return {"saved": False, "errors": "the YAML id must equal problem_id"}
        except Exception as exc:  # noqa: BLE001
            return {"saved": False, "ok": False, "stage": "schema", "errors": format_error(exc)}
        return await self.create_problem(yaml_text, overwrite=True)

    async def delete_problem(self, problem_id: str,
                             delete_user_code: bool = False) -> dict[str, Any]:
        removed = self.problems.delete(problem_id)
        if delete_user_code:
            self.workspace.remove(problem_id)
        await self.events.broadcast({"type": "problems_changed"})
        return {"deleted": removed}

    # ---------------------------------------------------------------- tutoring

    def get_session(self) -> dict[str, Any]:
        s = self.session
        p = self.problems.get(s.problem_id) if s.problem_id else None
        if p is None:
            return {"problem_id": None, "message": "The user has no problem open."}
        return {
            "problem_id": p.id,
            "title": p.title,
            "environment": p.environment,
            "judge": p.judge.kind,
            "description": p.description,
            "user_files": self.current_files(p),
            "readonly_files": {f.path: f.content for f in p.files if f.role == "readonly"},
            "active_file": s.active_file,
            "cursor": s.cursor,
            "selection": s.selection,
            "hints_revealed": self._state(p.id, "hints", {"revealed": 0})["revealed"],
            "hints_total": len(p.hints),
            "last_run": brief_run(self._state(p.id, "last_run", None)),
            "custom_tests": self._state(p.id, "custom_tests", []),
            "annotations": self.list_annotations(p.id),
            "pending_proposals": [{k: v for k, v in x.items() if k != "content"}
                                  for x in self.list_proposals(p.id)],
            "seconds_since_activity": round(time.time() - s.updated_at, 1)
            if s.updated_at else None,
        }

    async def open_problem(self, problem_id: str) -> dict[str, Any]:
        p = self.problem(problem_id)
        await self.events.broadcast({"type": "navigate", "problem_id": p.id})
        return {"opened": p.id}

    async def run_tests(self, problem_id: str | None = None, full: bool = False) -> dict[str, Any]:
        p = self.problem(problem_id)
        result = await self.run(p, files=self.current_files(p), source="mcp")
        return brief_run(result.model_dump(mode="json"), full=full) or {}

    # annotations

    def list_annotations(self, problem_id: str) -> list[dict[str, Any]]:
        return self._state(problem_id, "annotations", [])

    async def _save_annotations(self, problem_id: str, items: list[dict[str, Any]]) -> None:
        self.workspace.write_state(problem_id, "annotations", items)
        await self.events.broadcast({"type": "annotations_changed", "problem_id": problem_id,
                                     "annotations": items})

    async def annotate(self, items: list[dict[str, Any]], problem_id: str | None = None,
                       author: str = "assistant") -> list[dict[str, Any]]:
        p = self.problem(problem_id)
        created = review.make_annotations(p, self.current_files(p), items, author)
        await self._save_annotations(p.id, self.list_annotations(p.id) + created)
        return created

    async def remove_annotation(self, problem_id: str, annotation_id: str) -> bool:
        items = self.list_annotations(problem_id)
        kept = review.without_annotations(items, annotation_id=annotation_id)
        await self._save_annotations(problem_id, kept)
        return len(kept) != len(items)

    async def clear_annotations(self, problem_id: str | None = None,
                                file: str | None = None) -> int:
        p = self.problem(problem_id)
        items = self.list_annotations(p.id)
        kept = review.without_annotations(items, file=file, clear=True)
        await self._save_annotations(p.id, kept)
        return len(items) - len(kept)

    # proposals

    def list_proposals(self, problem_id: str) -> list[dict[str, Any]]:
        return self._state(problem_id, "proposals", [])

    async def _save_proposals(self, problem_id: str, items: list[dict[str, Any]],
                              added: bool = False) -> None:
        self.workspace.write_state(problem_id, "proposals", items)
        await self.events.broadcast({"type": "proposals_changed", "problem_id": problem_id,
                                     "proposals": items, "added": added})

    async def propose_edit(self, file: str, *, rationale: str = "", content: str | None = None,
                           edits: list[dict[str, str]] | None = None,
                           problem_id: str | None = None, author: str = "assistant",
                           source: str = "mcp") -> dict[str, Any]:
        p = self.problem(problem_id)
        proposal = review.make_proposal(p, self.current_files(p), file, content=content,
                                        edits=edits, rationale=rationale, author=author,
                                        source=source)
        await self._save_proposals(p.id, review.with_proposal(self.list_proposals(p.id), proposal),
                                   added=True)
        return proposal

    async def resolve_proposal(self, problem_id: str, proposal_id: str,
                               action: Literal["accept", "reject"]) -> dict[str, str]:
        if action not in ("accept", "reject"):
            raise ValueError("action must be accept or reject")
        p = self.problem(problem_id)
        items = self.list_proposals(p.id)
        proposal = next((x for x in items if x["id"] == proposal_id), None)
        if proposal is None:
            raise LookupError(f"no pending proposal {proposal_id!r}")
        await self._save_proposals(p.id, [x for x in items if x["id"] != proposal_id])
        if action == "accept":
            written = {proposal["file"]: proposal["content"]}
            self.workspace.save_files(p, written)
            if self.session.problem_id == p.id:
                self.session.buffers[proposal["file"]] = proposal["content"]
            await self.events.broadcast({"type": "files_changed", "problem_id": p.id,
                                         "files": written, "reason": "proposal_accepted"})
            return written
        # rejected disk edits: put the user's version back on disk
        if proposal.get("source") == "disk":
            self.workspace.save_files(p, {proposal["file"]: self.current_files(p)[proposal["file"]]})
        return {}

    async def add_test_case(self, args: list[Any], kwargs: dict[str, Any] | None = None,
                            name: str | None = None, description: str | None = None,
                            section: str | None = None,
                            problem_id: str | None = None) -> dict[str, Any]:
        p = self.problem(problem_id)
        tests = self._state(p.id, "custom_tests", [])
        tests.append(review.make_custom_test(p, tests, args, kwargs, name, description, section))
        await self.set_custom_tests(p.id, tests)
        return {"custom_tests": len(tests)}

    # ---------------------------------------------------------------- workspace (UI)

    def workspace_view(self, problem_id: str) -> dict[str, Any]:
        p = self.problem(problem_id)
        return {
            "files": self.workspace.files(p),
            "custom_tests": self._state(p.id, "custom_tests", []),
            "last_run": self._state(p.id, "last_run", None),
            "annotations": self._state(p.id, "annotations", []),
            "proposals": self._state(p.id, "proposals", []),
            "hints_revealed": self._state(p.id, "hints", {"revealed": 0})["revealed"],
        }

    def save_files(self, problem_id: str, files: dict[str, str]) -> dict[str, Any]:
        written = self.workspace.save_files(self.problem(problem_id), files)
        return {"written": sorted(written)}

    def reset_workspace(self, problem_id: str) -> dict[str, Any]:
        return {"files": self.workspace.reset(self.problem(problem_id))}

    async def set_custom_tests(self, problem_id: str, tests: list[dict[str, Any]],
                               broadcast: bool = True) -> dict[str, Any]:
        p = self.problem(problem_id)
        self.workspace.write_state(p.id, "custom_tests", tests)
        if broadcast:
            await self.events.broadcast({"type": "custom_tests_changed", "problem_id": p.id,
                                         "tests": tests})
        return {"tests": tests}

    def set_hints(self, problem_id: str, revealed: int) -> dict[str, Any]:
        p = self.problem(problem_id)
        revealed = max(0, min(revealed, len(p.hints)))
        self.workspace.write_state(p.id, "hints", {"revealed": revealed})
        return {"revealed": revealed}

    def report_session(self, **fields: Any) -> dict[str, Any]:
        self.session.update(**fields)
        return {"ok": True}

    def executors_for(self, problem_id: str | None = None) -> dict[str, Any]:
        requires: list[str] = []
        env = None
        if problem_id:
            p = self.problem(problem_id)
            env = self.environments.get(p.environment)
            requires = requirements(p, env)
        out = []
        for ex in self.executors.all().values():
            out.append({**ex.describe(),
                        "compatible": ex.supports(requires, env) if problem_id else True,
                        "device": ex.device_for(requires)})
        return {"executors": out, "requires": requires,
                "runtimes": sorted(env.runtimes()) if env else ["native"]}

    # ---------------------------------------------------------------- runs

    async def run(self, problem: Problem, *, files: dict[str, str] | None = None,
                  executor: str | None = None, run_id: str | None = None,
                  source: str = "ui") -> RunResult:
        """Run the user's code (given buffers, else the saved workspace) and record last_run."""
        if files:
            self.workspace.save_files(problem, files)
        current = self.workspace.files(problem)
        run_id = run_id or uuid.uuid4().hex[:12]
        lock = self.run_lock.setdefault(problem.id, asyncio.Lock())
        async with lock:
            await self.events.broadcast({"type": "run_started", "problem_id": problem.id,
                                         "run_id": run_id, "source": source})

            async def on_status(phase: str, detail: str) -> None:
                await self.events.broadcast({"type": "run_status", "problem_id": problem.id,
                                             "run_id": run_id, "phase": phase, "detail": detail})

            result = await self.orchestrator.run(
                RunRequest(problem=problem, files=current,
                           executor=executor or self.session.executor,
                           custom_tests=self._state(problem.id, "custom_tests", [])),
                run_id=run_id, on_status=on_status,
            )
            self.workspace.write_state(problem.id, "last_run", result.model_dump(mode="json"))
            await self.events.broadcast({"type": "run_finished", "problem_id": problem.id,
                                         "run_id": run_id, "source": source,
                                         "result": result.model_dump(mode="json")})
        return result

    async def cancel(self, run_id: str) -> dict[str, Any]:
        return {"cancelled": await self.orchestrator.cancel(run_id)}
