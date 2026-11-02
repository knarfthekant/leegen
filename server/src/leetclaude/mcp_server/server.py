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
from mcp.types import ToolAnnotations
from pydantic import BaseModel, Field

from leetclaude.core.toolspec import TOOLS
from leetclaude.schema.export import problem_json_schema
from leetclaude.service import ToolService
from leetclaude.state import app_state
from leetclaude.store.problems import dump_problem_yaml

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


def _svc() -> ToolService:
    return app_state().service


class AnnotationIn(BaseModel):
    file: str | None = Field(None, description="Visible file path; omit for a general comment.")
    start_line: int | None = Field(None, description="1-based first line (required with file).")
    end_line: int | None = Field(None, description="1-based last line; defaults to start_line.")
    start_col: int | None = Field(
        None, description="1-based column where the highlight starts on start_line. Give exact "
        "columns whenever the problem is one token or expression. Omit both columns to mark the "
        "text of the line(s), without indentation.")
    end_col: int | None = Field(
        None, description="1-based column on end_line, exclusive (one past the last highlighted "
        "character). Defaults to the end of the text on end_line when start_col is given.")
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
    mcp = MCPServer(name="leetclaude", instructions=INSTRUCTIONS, version="1.3.0")
    _tool = mcp.tool

    def tool() -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def deco(fn: Callable[..., Any]) -> Callable[..., Any]:
            spec = TOOLS[fn.__name__]
            hints = ToolAnnotations(title=spec.title, read_only_hint=spec.read_only,
                                    destructive_hint=spec.consequential)
            return _tool(title=spec.title, annotations=hints)(_agent_errors(fn))
        return deco

    # ============================================================ authoring

    @tool()
    def get_authoring_guide() -> str:
        """How to write leetclaude problems: schema walkthrough, judge kinds, test design, markup,
        and worked examples. Read this before creating problems."""
        return _svc().authoring_guide()

    @tool()
    def get_tutoring_guide() -> str:
        """How to tutor the user in leetclaude: call get_session first, hint in small steps,
        annotate exact ranges, change code only through propose_edit. Read this before helping
        with a problem."""
        return _svc().tutoring_guide()

    @tool()
    def get_problem_schema() -> dict[str, Any]:
        """JSON Schema of the problem YAML format."""
        return problem_json_schema()

    @tool()
    def list_environments() -> dict[str, Any]:
        """Environments problems can use, and which executors can run each of them."""
        return _svc().list_environments()

    @tool()
    def list_executors() -> dict[str, Any]:
        """Configured executors (where code runs) and their capabilities (cpu, mps, cuda)."""
        return _svc().list_executors()

    @tool()
    def list_problems(track: str | None = None) -> dict[str, Any]:
        """All problems (optionally only one track), plus files that failed to load."""
        return _svc().list_problems(track)

    @tool()
    def get_problem(problem_id: str, include_hidden: bool = True) -> dict[str, Any]:
        """A problem. With include_hidden (default) returns the full YAML, including hidden files
        and the reference solution. Otherwise returns only what the user can see."""
        return _svc().get_problem(problem_id, include_hidden)

    @tool()
    async def validate_problem_yaml(yaml: str) -> dict[str, Any]:
        """Check a problem without saving it: the schema, then the reference solution must pass
        every test and the starter code must fail at least one."""
        _, report = await _svc().validate_yaml(yaml)
        return report

    @tool()
    async def create_problem(yaml: str, overwrite: bool = False) -> dict[str, Any]:
        """Validate and save a problem to problems/<id>.yaml. Nothing is saved if validation fails
        (a problem is saved unvalidated only when no executor can run it, and the response
        says so). Use overwrite=true to replace an existing problem."""
        return await _svc().create_problem(yaml, overwrite)

    @tool()
    async def update_problem(problem_id: str, yaml: str) -> dict[str, Any]:
        """Replace an existing problem with new YAML (validated the same way as create_problem).
        The user's saved code for the problem is kept."""
        return await _svc().update_problem(problem_id, yaml)

    @tool()
    async def delete_problem(problem_id: str, delete_user_code: bool = False) -> dict[str, Any]:
        """Delete a problem file (and optionally the user's workspace for it)."""
        return await _svc().delete_problem(problem_id, delete_user_code)

    # ============================================================ tutoring

    @tool()
    def get_session() -> dict[str, Any]:
        """What the user is doing right now: the open problem, their current code (including
        unsaved edits), cursor and selection, the last run's results, custom tests, and existing
        review comments and pending suggestions. Call this first when helping the user."""
        return _svc().get_session()

    @tool()
    async def open_problem(problem_id: str) -> dict[str, Any]:
        """Open a problem in the user's browser."""
        return await _svc().open_problem(problem_id)

    @tool()
    async def run_tests(problem_id: str | None = None, full: bool = False) -> dict[str, Any]:
        """Run the user's current code against all tests (the same as clicking Run). Results
        appear in the UI too. Returns failing tests (or every test with full=true)."""
        return await _svc().run_tests(problem_id, full)

    @tool()
    async def annotate(annotations: list[AnnotationIn], problem_id: str | None = None,
                       author: str = "assistant") -> dict[str, Any]:
        """Comment on the user's code. Each annotation marks an exact character range in a
        visible file (or is a general comment when file is omitted). In the editor it shows as a
        highlight plus one gutter dot (a bar for several lines); hovering peeks at it and
        clicking focuses it in the Review tab. Lines and columns are 1-based and refer to the
        current code from get_session; end_col is exclusive. Always prefer start_col/end_col
        that cover just the offending token or expression; without columns the whole text of
        the line(s) is marked. Comments may overlap, and each stays visible."""
        created = await _svc().annotate([a.model_dump() for a in annotations], problem_id, author)
        return {"created": [c["id"] for c in created]}

    @tool()
    async def clear_annotations(problem_id: str | None = None,
                                file: str | None = None) -> dict[str, Any]:
        """Remove review comments (all of them, or only those on one file)."""
        return {"removed": await _svc().clear_annotations(problem_id, file)}

    @tool()
    async def propose_edit(file: str, rationale: str, content: str | None = None,
                           edits: list[EditIn] | None = None, problem_id: str | None = None,
                           author: str = "assistant") -> dict[str, Any]:
        """Suggest a change to one of the user's editable files. Shown as a diff the user accepts
        or rejects. Give either the full new `content` or a list of exact search/replace
        `edits`. A newer proposal for the same file replaces the pending one."""
        proposal = await _svc().propose_edit(
            file, content=content, edits=[e.model_dump() for e in edits] if edits else None,
            rationale=rationale, problem_id=problem_id, author=author)
        return {"proposal_id": proposal["id"], "status": "pending user review"}

    @tool()
    async def add_test_case(args: list[Any], kwargs: dict[str, Any] | None = None,
                            name: str | None = None, description: str | None = None,
                            section: str | None = None,
                            problem_id: str | None = None) -> dict[str, Any]:
        """Add a custom test case to the user's Testcase panel (function-judge problems only).
        The expected output is computed by the reference solution. Unnamed cases are called
        `Test <n>`. `section` must be one of the problem's section ids (see get_problem)."""
        return await _svc().add_test_case(args, kwargs, name, description, section, problem_id)

    # ============================================================ resources

    @mcp.resource("schema://problem", mime_type="application/json")
    def schema_resource() -> str:
        return json.dumps(problem_json_schema(), indent=2)

    @mcp.resource("docs://authoring", mime_type="text/markdown")
    def authoring_resource() -> str:
        return _svc().authoring_guide()

    @mcp.resource("problem://{problem_id}", mime_type="application/yaml")
    def problem_resource(problem_id: str) -> str:
        return dump_problem_yaml(_svc().problem(problem_id))

    return mcp
