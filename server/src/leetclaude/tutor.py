"""Annotations (comments/highlights on the user's code) and proposals (suggested edits).

Used by the REST API, the MCP tools and the file watcher. Every change is pushed to the UI.
"""

from __future__ import annotations

import time
import uuid
from typing import Any, Literal

from leetclaude.schema.models import Problem
from leetclaude.state import app_state

Severity = Literal["info", "hint", "warning", "error", "praise"]
SEVERITIES = ("info", "hint", "warning", "error", "praise")


def _ws():  # type: ignore[no-untyped-def]
    return app_state().workspace


def current_files(problem: Problem) -> dict[str, str]:
    """The user's code as they see it: unsaved browser buffers win over disk."""
    files = _ws().files(problem)
    sess = app_state().session
    if sess.problem_id == problem.id:
        for path, content in sess.buffers.items():
            if path in files:
                files[path] = content
    return files


# ------------------------------------------------------------------ annotations


def list_annotations(problem_id: str) -> list[dict[str, Any]]:
    return _ws().read_state(problem_id, "annotations", [])


async def _save_annotations(problem_id: str, items: list[dict[str, Any]]) -> None:
    _ws().write_state(problem_id, "annotations", items)
    await app_state().hub.broadcast({"type": "annotations_changed", "problem_id": problem_id,
                                     "annotations": items})


def _resolve_columns(start_col: int | None, end_col: int | None, start: int, end: int,
                     lines: list[str], file: str) -> tuple[int, int]:
    """Every annotation on a file ends up with an exact character range. Columns are 1-based and
    `end_col` is exclusive (the position just after the last character), like an editor
    selection.

    - no columns: the text of the line(s), without the leading indentation and trailing spaces
    - `start_col` only: from there to the end of the text on the last line
    - both: exactly that range, validated against the code
    """
    first, last = lines[start - 1], lines[end - 1]
    if start_col is None:
        if end_col is not None:
            raise ValueError("end_col needs start_col")
        start_col = len(first) - len(first.lstrip()) + 1
        end_col = len(last.rstrip()) + 1
        if start == end and end_col < start_col:  # blank line: an empty range
            end_col = start_col
        return start_col, end_col
    if end_col is None:
        end_col = max(len(last.rstrip()) + 1, start_col if start == end else 1)
    if not (1 <= start_col <= len(first) + 1):
        raise ValueError(f"start_col {start_col} is outside line {start} of {file} "
                         f"(1-{len(first) + 1})")
    if not (1 <= end_col <= len(last) + 1):
        raise ValueError(f"end_col {end_col} is outside line {end} of {file} (1-{len(last) + 1})")
    if start == end and end_col <= start_col:
        raise ValueError("end_col must be greater than start_col on a single line "
                         "(end_col is exclusive)")
    return start_col, end_col


async def add_annotations(problem: Problem, items: list[dict[str, Any]],
                          author: str = "assistant") -> list[dict[str, Any]]:
    files = current_files(problem)
    visible_paths = {f.path for f in problem.files if f.role != "hidden"}
    created = []
    for item in items:
        file = item.get("file")
        severity = item.get("severity", "info")
        if severity not in SEVERITIES:
            raise ValueError(f"severity must be one of {SEVERITIES}")
        if not item.get("message"):
            raise ValueError("each annotation needs a message")
        start = item.get("start_line")
        end = item.get("end_line") or start
        if file is not None:
            if file not in visible_paths:
                raise ValueError(f"{file!r} is not a visible file of {problem.id}")
            content = files.get(file) or (problem.file(file).content if problem.file(file) else "")
            n_lines = max(1, content.count("\n") + 1)
            if start is None:
                raise ValueError("annotations on a file need start_line (1-based)")
            if not (1 <= start <= n_lines) or not (start <= end <= n_lines):
                raise ValueError(f"line range {start}-{end} is outside {file} (1-{n_lines})")
            lines = content.split("\n")
            start_col, end_col = _resolve_columns(
                item.get("start_col"), item.get("end_col"), start, end, lines, file)
        else:
            start_col = end_col = None
        created.append({
            "id": uuid.uuid4().hex[:10], "file": file, "start_line": start,
            "end_line": end if file else None, "start_col": start_col,
            "end_col": end_col, "severity": severity, "message": item["message"],
            "author": item.get("author") or author, "created_at": time.time(),
        })
    all_items = list_annotations(problem.id) + created
    await _save_annotations(problem.id, all_items)
    return created


async def remove_annotation(problem_id: str, annotation_id: str) -> bool:
    items = list_annotations(problem_id)
    kept = [a for a in items if a["id"] != annotation_id]
    await _save_annotations(problem_id, kept)
    return len(kept) != len(items)


async def clear_annotations(problem_id: str, file: str | None = None) -> int:
    items = list_annotations(problem_id)
    kept = [a for a in items if file is not None and a.get("file") != file]
    await _save_annotations(problem_id, kept)
    return len(items) - len(kept)


# ------------------------------------------------------------------ proposals


def list_proposals(problem_id: str) -> list[dict[str, Any]]:
    return _ws().read_state(problem_id, "proposals", [])


async def _save_proposals(problem_id: str, items: list[dict[str, Any]], added: bool = False) -> None:
    _ws().write_state(problem_id, "proposals", items)
    await app_state().hub.broadcast({"type": "proposals_changed", "problem_id": problem_id,
                                     "proposals": items, "added": added})


def apply_edits(content: str, edits: list[dict[str, str]]) -> str:
    """Apply search/replace edits. Each `old` must occur exactly once."""
    for i, e in enumerate(edits):
        old, new = e.get("old", ""), e.get("new", "")
        count = content.count(old) if old else 0
        if count != 1:
            raise ValueError(f"edit {i + 1}: `old` text must match exactly once (found {count})")
        content = content.replace(old, new, 1)
    return content


async def propose_edit(problem: Problem, file: str, *, content: str | None = None,
                       edits: list[dict[str, str]] | None = None, rationale: str = "",
                       author: str = "assistant", source: str = "mcp") -> dict[str, Any]:
    f = problem.file(file)
    if f is None or f.role != "editable":
        raise ValueError(f"{file!r} is not an editable file of {problem.id}")
    base = current_files(problem)[file]
    if content is None:
        if not edits:
            raise ValueError("give either `content` (the full new file) or `edits`")
        content = apply_edits(base, edits)
    if content == base:
        raise ValueError("the proposed content is identical to the current code")
    proposal = {"id": uuid.uuid4().hex[:10], "file": file, "content": content,
                "rationale": rationale, "author": author, "source": source,
                "created_at": time.time()}
    # one pending proposal per file: a newer one replaces the older one
    items = [p for p in list_proposals(problem.id) if p["file"] != file] + [proposal]
    await _save_proposals(problem.id, items, added=True)
    return proposal


async def resolve_proposal(problem: Problem, proposal_id: str,
                           action: Literal["accept", "reject"]) -> dict[str, str]:
    items = list_proposals(problem.id)
    proposal = next((p for p in items if p["id"] == proposal_id), None)
    if proposal is None:
        raise KeyError(f"no pending proposal {proposal_id!r}")
    await _save_proposals(problem.id, [p for p in items if p["id"] != proposal_id])
    st = app_state()
    if action == "accept":
        written = {proposal["file"]: proposal["content"]}
        st.workspace.save_files(problem, written)
        if st.session.problem_id == problem.id:
            st.session.buffers[proposal["file"]] = proposal["content"]
        await st.hub.broadcast({"type": "files_changed", "problem_id": problem.id,
                                "files": written, "reason": "proposal_accepted"})
        return written
    # rejected disk edits: put the user's version back on disk
    if proposal.get("source") == "disk":
        st.workspace.save_files(problem, {proposal["file"]: current_files(problem)[proposal["file"]]})
    return {}
