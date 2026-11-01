"""MCP server (streamable HTTP at /mcp), served by the same process as the web app.

Two groups of tools:
- authoring: create/validate/update problems
- tutoring: read what the user is doing, run their code, annotate it, propose edits
"""

from __future__ import annotations

import functools
import inspect
import json
from typing import Any, Callable, Literal

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import BaseModel, Field

from leetclaude import tutor
from leetclaude.runner.orchestrator import unique_test_name
from leetclaude.schema.export import problem_json_schema
from leetclaude.schema.models import Problem
from leetclaude.schema.views import problem_summary, public_problem
from leetclaude.services import run_for_user
from leetclaude.state import app_state
from leetclaude.store.problems import dump_problem_yaml, format_error, parse_problem_yaml
from leetclaude.validate import validate_problem

INSTRUCTIONS = """\
leetclaude is a local LeetCode-style training app. Problems are YAML files; the user solves them
in a browser editor and runs tests on CPU or GPU executors.

Authoring: call get_authoring_guide once, then validate_problem / create_problem with full YAML.
create_problem only saves when the reference solution passes every test and the starter fails.

Tutoring (helping the user with the problem they have open): call get_session first. Give hints
in small steps, and don't hand over a full solution unless the user asks for it. Use annotate to
comment on specific lines, and propose_edit (never direct file writes) to suggest code changes,
which the user accepts or rejects in the editor.
"""


def _problem(problem_id: str | None) -> Problem:
    st = app_state()
    pid = problem_id or st.session.problem_id
    if not pid:
        raise ValueError("no problem_id given and the user has no problem open")
    p = st.problems.get(pid)
    if p is None:
        raise ValueError(f"no problem {pid!r}; call list_problems")
    return p


def _brief_run(result: dict[str, Any] | None, *, full: bool = False) -> dict[str, Any] | None:
    if not result:
        return None
    tests = result.get("tests", [])
    shown = tests if full else [t for t in tests if t.get("status") != "pass"]
    return {
        "status": result.get("status"), "passed": result.get("passed"),
        "total": result.get("total"), "executor": result.get("executor"),
        "device": result.get("device"), "error": result.get("error"),
        "compile_output": result.get("compile_output"), "metrics": result.get("metrics"),
        "tests" if full else "failing_tests": [
            {k: t.get(k) for k in ("name", "section", "description", "status", "visible", "input",
                                   "expected", "actual", "message", "stdout") if t.get(k) is not None}
            for t in shown
        ],
    }


class AnnotationIn(BaseModel):
    file: str | None = Field(None, description="Visible file path; omit for a general comment.")
    start_line: int | None = Field(None, description="1-based first line (required with file).")
    end_line: int | None = Field(None, description="1-based last line; defaults to start_line.")
    start_col: int | None = Field(
        None, description="Optional 1-based column where the highlight starts on start_line. "
        "Omit both columns to highlight whole lines.")
    end_col: int | None = Field(
        None, description="Optional 1-based column on end_line, exclusive (one past the last "
        "highlighted character). Defaults to the end of end_line when start_col is given.")
    severity: Literal["info", "hint", "warning", "error", "praise"] = "info"
    message: str = Field(description="Markdown. Keep it short and specific.")


class EditIn(BaseModel):
    old: str = Field(description="Exact text currently in the file; must match exactly once.")
    new: str = Field(description="Replacement text.")


def _agent_errors(fn: Callable[..., Any]) -> Callable[..., Any]:
    """Expected failures (bad arguments, unknown ids) reach the agent with their message."""
    expected = (ValueError, KeyError, LookupError)
    if inspect.iscoroutinefunction(fn):
        @functools.wraps(fn)
        async def async_wrapper(*args: Any, **kwargs: Any) -> Any:
            try:
                return await fn(*args, **kwargs)
            except expected as exc:
                raise ToolError(str(exc).strip("'\"")) from exc
        return async_wrapper

    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        try:
            return fn(*args, **kwargs)
        except expected as exc:
            raise ToolError(str(exc).strip("'\"")) from exc
    return wrapper


def build_mcp() -> MCPServer:
    mcp = MCPServer(name="leetclaude", instructions=INSTRUCTIONS, version="1.2.0")
    _tool = mcp.tool

    def tool() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            return _tool()(_agent_errors(fn))
        return deco

    # ============================================================ authoring

    @tool()
    def get_authoring_guide() -> str:
        """How to write leetclaude problems: schema walkthrough, judge kinds, test design, markup,
        and worked examples. Read this before creating problems."""
        guide = app_state().problems.dir.parent / "docs" / "authoring.md"
        return guide.read_text() if guide.exists() else "docs/authoring.md is missing"

    @tool()
    def get_problem_schema() -> dict[str, Any]:
        """JSON Schema of the problem YAML format."""
        return problem_json_schema()

    @tool()
    def list_environments() -> dict[str, Any]:
        """Environments problems can use, and which executors can run each of them."""
        st = app_state()
        out = []
        for env in st.environments.all().values():
            runnable = [e.id for e in st.executors.compatible(sorted(env.requires))]
            out.append({**env.model_dump(), "executors": runnable})
        return {"environments": out}

    @tool()
    def list_executors() -> dict[str, Any]:
        """Configured executors (where code runs) and their capabilities (cpu, mps, cuda)."""
        return {"executors": [e.describe() for e in app_state().executors.all().values()]}

    @tool()
    def list_problems(track: str | None = None) -> dict[str, Any]:
        """All problems (optionally only one track), plus files that failed to load."""
        st = app_state()
        items = [problem_summary(p) for p in st.problems.list() if not track or p.track == track]
        errors = [{"path": e.path, "error": e.error} for e in st.problems.errors()]
        return {"problems": items, "invalid_files": errors}

    @tool()
    def get_problem(problem_id: str, include_hidden: bool = True) -> dict[str, Any]:
        """A problem. With include_hidden (default) returns the full YAML, including hidden files
        and the reference solution. Otherwise returns only what the user can see."""
        p = _problem(problem_id)
        if include_hidden:
            return {"id": p.id, "yaml": dump_problem_yaml(p)}
        return public_problem(p)

    async def _validate_yaml(yaml_text: str) -> tuple[Problem | None, dict[str, Any]]:
        try:
            problem = parse_problem_yaml(yaml_text)
        except Exception as exc:  # noqa: BLE001
            return None, {"ok": False, "stage": "schema", "errors": format_error(exc)}
        report = await validate_problem(problem)
        return problem, {"stage": "run", **report.to_dict()}

    @tool()
    async def validate_problem_yaml(yaml: str) -> dict[str, Any]:
        """Check a problem without saving it: the schema, then the reference solution must pass
        every test and the starter code must fail at least one."""
        _, report = await _validate_yaml(yaml)
        return report

    @tool()
    async def create_problem(yaml: str, overwrite: bool = False) -> dict[str, Any]:
        """Validate and save a problem to problems/<id>.yaml. Nothing is saved if validation fails
        (a problem is saved unvalidated only when no executor can run it, and the response
        says so). Use overwrite=true to replace an existing problem."""
        st = app_state()
        problem, report = await _validate_yaml(yaml)
        if problem is None:
            return {"saved": False, **report}
        if st.problems.get(problem.id) and not overwrite:
            return {"saved": False, "ok": False,
                    "errors": f"problem {problem.id!r} exists; pass overwrite=true to replace it"}
        if not report.get("ok") and not report.get("skipped"):
            return {"saved": False, **report}
        path = st.problems.save(problem)
        await st.hub.broadcast({"type": "problems_changed"})
        await st.hub.broadcast({"type": "problem_changed", "problem_id": problem.id})
        return {"saved": True, "path": str(path), "validated": bool(report.get("ok")), **report}

    @tool()
    async def update_problem(problem_id: str, yaml: str) -> dict[str, Any]:
        """Replace an existing problem with new YAML (validated the same way as create_problem).
        The user's saved code for the problem is kept."""
        if app_state().problems.get(problem_id) is None:
            return {"saved": False, "errors": f"no problem {problem_id!r}"}
        try:
            if parse_problem_yaml(yaml).id != problem_id:
                return {"saved": False, "errors": "the YAML id must equal problem_id"}
        except Exception as exc:  # noqa: BLE001
            return {"saved": False, "ok": False, "stage": "schema", "errors": format_error(exc)}
        return await create_problem(yaml, overwrite=True)

    @tool()
    async def delete_problem(problem_id: str, delete_user_code: bool = False) -> dict[str, Any]:
        """Delete a problem file (and optionally the user's workspace for it)."""
        st = app_state()
        removed = st.problems.delete(problem_id)
        if delete_user_code:
            st.workspace.remove(problem_id)
        await st.hub.broadcast({"type": "problems_changed"})
        return {"deleted": removed}

    # ============================================================ tutoring

    @tool()
    def get_session() -> dict[str, Any]:
        """What the user is doing right now: the open problem, their current code (including
        unsaved edits), cursor and selection, the last run's results, custom tests, and existing
        review comments and pending suggestions. Call this first when helping the user."""
        st = app_state()
        s = st.session
        if not s.problem_id or st.problems.get(s.problem_id) is None:
            return {"problem_id": None, "message": "The user has no problem open."}
        p = st.problems.get(s.problem_id)
        assert p is not None
        ws = st.workspace
        files = tutor.current_files(p)
        return {
            "problem_id": p.id,
            "title": p.title,
            "environment": p.environment,
            "judge": p.judge.kind,
            "description": p.description,
            "user_files": files,
            "readonly_files": {f.path: f.content for f in p.files if f.role == "readonly"},
            "active_file": s.active_file,
            "cursor": s.cursor,
            "selection": s.selection,
            "hints_revealed": ws.read_state(p.id, "hints", {"revealed": 0})["revealed"],
            "hints_total": len(p.hints),
            "last_run": _brief_run(ws.read_state(p.id, "last_run", None)),
            "custom_tests": ws.read_state(p.id, "custom_tests", []),
            "annotations": tutor.list_annotations(p.id),
            "pending_proposals": [{k: v for k, v in x.items() if k != "content"}
                                  for x in tutor.list_proposals(p.id)],
            "seconds_since_activity": round(__import__("time").time() - s.updated_at, 1)
            if s.updated_at else None,
        }

    @tool()
    async def open_problem(problem_id: str) -> dict[str, Any]:
        """Open a problem in the user's browser."""
        p = _problem(problem_id)
        await app_state().hub.broadcast({"type": "navigate", "problem_id": p.id})
        return {"opened": p.id}

    @tool()
    async def run_tests(problem_id: str | None = None, full: bool = False) -> dict[str, Any]:
        """Run the user's current code against all tests (the same as clicking Run). Results
        appear in the UI too. Returns failing tests (or every test with full=true)."""
        p = _problem(problem_id)
        files = tutor.current_files(p)
        result = await run_for_user(p, files=files, source="mcp")
        return _brief_run(result.model_dump(mode="json"), full=full) or {}

    @tool()
    async def annotate(annotations: list[AnnotationIn], problem_id: str | None = None,
                       author: str = "assistant") -> dict[str, Any]:
        """Comment on the user's code. Each annotation highlights a line range, or an exact
        character range when start_col/end_col are given, in a visible file (or is a general
        comment when file is omitted). It shows up in the editor (hover to peek, click to open
        it in Review) and in the Review tab. Lines and columns are 1-based and refer to the
        current code from get_session; end_col is exclusive. Prefer a precise range over a
        whole line when the problem is one expression or token."""
        p = _problem(problem_id)
        created = await tutor.add_annotations(p, [a.model_dump() for a in annotations], author)
        return {"created": [c["id"] for c in created]}

    @tool()
    async def clear_annotations(problem_id: str | None = None,
                                file: str | None = None) -> dict[str, Any]:
        """Remove review comments (all of them, or only those on one file)."""
        p = _problem(problem_id)
        return {"removed": await tutor.clear_annotations(p.id, file)}

    @tool()
    async def propose_edit(file: str, rationale: str, content: str | None = None,
                           edits: list[EditIn] | None = None, problem_id: str | None = None,
                           author: str = "assistant") -> dict[str, Any]:
        """Suggest a change to one of the user's editable files. Shown as a diff the user accepts
        or rejects. Give either the full new `content` or a list of exact search/replace
        `edits`. A newer proposal for the same file replaces the pending one."""
        p = _problem(problem_id)
        proposal = await tutor.propose_edit(
            p, file, content=content, edits=[e.model_dump() for e in edits] if edits else None,
            rationale=rationale, author=author)
        return {"proposal_id": proposal["id"], "status": "pending user review"}

    @tool()
    async def add_test_case(args: list[Any], kwargs: dict[str, Any] | None = None,
                            name: str | None = None, description: str | None = None,
                            section: str | None = None,
                            problem_id: str | None = None) -> dict[str, Any]:
        """Add a custom test case to the user's Testcase panel (function-judge problems only).
        The expected output is computed by the reference solution. Unnamed cases are called
        `Test <n>`. `section` must be one of the problem's section ids (see get_problem)."""
        p = _problem(problem_id)
        if p.judge.kind != "function":
            raise ValueError("custom test cases are only supported for function-judge problems")
        if not p.reference:
            raise ValueError("this problem has no reference solution to compute expected output")
        st = app_state()
        tests = st.workspace.read_state(p.id, "custom_tests", [])
        if section is not None and section not in {s.id for s in p.sections}:
            raise ValueError(f"unknown section {section!r}; "
                             f"sections: {[s.id for s in p.sections]}")
        taken = {t.name for t in p.tests} | {t.get("name") for t in tests if t.get("name")}
        test: dict[str, Any] = {"input": {"args": args, "kwargs": kwargs or {}},
                                "name": unique_test_name(name, taken)}
        if description:
            test["description"] = description
        if section:
            test["section"] = section
        tests.append(test)
        st.workspace.write_state(p.id, "custom_tests", tests)
        await st.hub.broadcast({"type": "custom_tests_changed", "problem_id": p.id,
                                "tests": tests})
        return {"custom_tests": len(tests)}

    # ============================================================ resources

    @mcp.resource("schema://problem", mime_type="application/json")
    def schema_resource() -> str:
        return json.dumps(problem_json_schema(), indent=2)

    @mcp.resource("docs://authoring", mime_type="text/markdown")
    def authoring_resource() -> str:
        return get_authoring_guide()

    @mcp.resource("problem://{problem_id}", mime_type="application/yaml")
    def problem_resource(problem_id: str) -> str:
        return dump_problem_yaml(_problem(problem_id))

    return mcp
