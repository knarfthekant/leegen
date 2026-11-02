"""Agent tool metadata shared by the MCP server and the browser edition's WebMCP tools.

Descriptions and input schemas come from the MCP tool definitions (mcp_server/server.py); this
file adds what both protocols need on top: a title and behaviour hints. `leegen schema`
merges both into contracts/tools.json, which the browser registers its WebMCP tools from.

Hints map to MCP `ToolAnnotations` (read_only_hint, destructive_hint) and WebMCP annotations
(readOnlyHint, consequentialHint, untrustedContentHint).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolSpec:
    title: str
    read_only: bool = False
    consequential: bool = False       # destructive / hard to undo
    untrusted_output: bool = False    # returns user code, stdout or agent-authored content
    browser: bool = True              # offered by the browser edition's WebMCP layer


TOOLS: dict[str, ToolSpec] = {
    # authoring
    "get_authoring_guide": ToolSpec("Authoring guide", read_only=True),
    "get_tutoring_guide": ToolSpec("Tutoring guide", read_only=True),
    "get_problem_schema": ToolSpec("Problem JSON Schema", read_only=True),
    "list_environments": ToolSpec("List environments", read_only=True),
    "list_executors": ToolSpec("List executors", read_only=True),
    "list_problems": ToolSpec("List problems", read_only=True),
    "get_problem": ToolSpec("Get problem", read_only=True, untrusted_output=True),
    "validate_problem_yaml": ToolSpec("Validate problem YAML", read_only=True),
    "create_problem": ToolSpec("Create problem"),
    "update_problem": ToolSpec("Update problem"),
    "delete_problem": ToolSpec("Delete problem", consequential=True),
    # tutoring
    "get_session": ToolSpec("Get the user's session", read_only=True, untrusted_output=True),
    "open_problem": ToolSpec("Open problem"),
    "run_tests": ToolSpec("Run tests", untrusted_output=True),
    "annotate": ToolSpec("Annotate code"),
    "clear_annotations": ToolSpec("Clear annotations"),
    "propose_edit": ToolSpec("Propose an edit"),
    "add_test_case": ToolSpec("Add a test case"),
}

TUTORING_GUIDE = """\
# Tutoring with leegen

leegen is a LeetCode-style trainer. The user solves a problem in the editor (description on
the left, code and tests on the right). You are their tutor.

1. **Call `get_session` first.** It returns the open problem, the user's *current* code (with
   unsaved edits), cursor and selection, the last run's failing tests, existing comments and
   pending suggestions.
2. **Diagnose from evidence.** Read the failing tests' input, expected, actual and message. Use
   `run_tests` to check a hypothesis on their current code. `get_problem` with
   `include_hidden=true` shows the reference and hidden tests: use them to understand the
   problem, never paste them to the user.
3. **Hints in small steps.** Concept first, then location, then the fix. Don't write the whole
   solution unless the user explicitly asks. This is a training tool.
4. **Comment with `annotate`:** 1-based lines; add `start_col`/`end_col` (end exclusive) to mark
   exactly the offending token. Severities: hint, warning, error, info, praise. Omit `file` for a
   general comment. Clear stale comments with `clear_annotations`.
5. **Change code only with `propose_edit`** (prefer small exact `edits`). The user accepts or
   rejects the diff. Never overwrite their code another way.
6. `add_test_case` adds an input to the user's Testcase panel (function-judge problems);
   `open_problem` moves the editor to another problem.
7. Code review order: correctness (point at failing cases), then complexity, then style. Praise
   what is good.
"""
