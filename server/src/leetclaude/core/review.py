"""Pure review logic: annotations, search/replace edits, proposals and custom test cases.

No storage and no events here. Ids and timestamps come from the caller (`new_id`, `now`), so
the browser edition's TypeScript port can be checked against fixtures generated from this code.
"""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from typing import Any, Literal

from leetclaude.core.models import Problem
from leetclaude.core.plan import unique_test_name

Severity = Literal["info", "hint", "warning", "error", "praise"]
SEVERITIES = ("info", "hint", "warning", "error", "praise")


def default_id() -> str:
    return uuid.uuid4().hex[:10]


def resolve_columns(start_col: int | None, end_col: int | None, start: int, end: int,
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


def make_annotations(problem: Problem, files: dict[str, str], items: list[dict[str, Any]],
                     author: str = "assistant", *, now: Callable[[], float] = time.time,
                     new_id: Callable[[], str] = default_id) -> list[dict[str, Any]]:
    """Validate annotation requests against the user's current code and build the records."""
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
            pf = problem.file(file)
            content = files.get(file) or (pf.content if pf else "")
            n_lines = max(1, content.count("\n") + 1)
            if start is None:
                raise ValueError("annotations on a file need start_line (1-based)")
            if not (1 <= start <= n_lines) or not (start <= end <= n_lines):
                raise ValueError(f"line range {start}-{end} is outside {file} (1-{n_lines})")
            lines = content.split("\n")
            start_col, end_col = resolve_columns(
                item.get("start_col"), item.get("end_col"), start, end, lines, file)
        else:
            start_col = end_col = None
        created.append({
            "id": new_id(), "file": file, "start_line": start,
            "end_line": end if file else None, "start_col": start_col,
            "end_col": end_col, "severity": severity, "message": item["message"],
            "author": item.get("author") or author, "created_at": now(),
        })
    return created


def without_annotations(items: list[dict[str, Any]], *, annotation_id: str | None = None,
                        file: str | None = None, clear: bool = False) -> list[dict[str, Any]]:
    """Remove one annotation by id, or (clear=True) all of them / all on one file."""
    if clear:
        return [a for a in items if file is not None and a.get("file") != file]
    return [a for a in items if a["id"] != annotation_id]


def apply_edits(content: str, edits: list[dict[str, str]]) -> str:
    """Apply search/replace edits. Each `old` must occur exactly once."""
    for i, e in enumerate(edits):
        old, new = e.get("old", ""), e.get("new", "")
        count = content.count(old) if old else 0
        if count != 1:
            raise ValueError(f"edit {i + 1}: `old` text must match exactly once (found {count})")
        content = content.replace(old, new, 1)
    return content


def make_proposal(problem: Problem, files: dict[str, str], file: str, *,
                  content: str | None = None, edits: list[dict[str, str]] | None = None,
                  rationale: str = "", author: str = "assistant", source: str = "mcp",
                  now: Callable[[], float] = time.time,
                  new_id: Callable[[], str] = default_id) -> dict[str, Any]:
    f = problem.file(file)
    if f is None or f.role != "editable":
        raise ValueError(f"{file!r} is not an editable file of {problem.id}")
    base = files[file]
    if content is None:
        if not edits:
            raise ValueError("give either `content` (the full new file) or `edits`")
        content = apply_edits(base, edits)
    if content == base:
        raise ValueError("the proposed content is identical to the current code")
    return {"id": new_id(), "file": file, "content": content, "rationale": rationale,
            "author": author, "source": source, "created_at": now()}


def with_proposal(items: list[dict[str, Any]], proposal: dict[str, Any]) -> list[dict[str, Any]]:
    """One pending proposal per file: a newer one replaces the older one."""
    return [p for p in items if p["file"] != proposal["file"]] + [proposal]


def make_custom_test(problem: Problem, existing: list[dict[str, Any]], args: list[Any],
                     kwargs: dict[str, Any] | None = None, name: str | None = None,
                     description: str | None = None,
                     section: str | None = None) -> dict[str, Any]:
    """A user test case for a function-judge problem (expected value comes from the reference)."""
    if problem.judge.kind != "function":
        raise ValueError("custom test cases are only supported for function-judge problems")
    if not problem.reference:
        raise ValueError("this problem has no reference solution to compute expected output")
    if not isinstance(args, list):
        raise ValueError("args must be a list of positional arguments")
    if section is not None and section not in {s.id for s in problem.sections}:
        raise ValueError(f"unknown section {section!r}; "
                         f"sections: {[s.id for s in problem.sections]}")
    taken = {t.name for t in problem.tests} | {t.get("name") for t in existing if t.get("name")}
    test: dict[str, Any] = {"input": {"args": args, "kwargs": kwargs or {}},
                            "name": unique_test_name(name, taken)}
    if description:
        test["description"] = description
    if section:
        test["section"] = section
    return test
